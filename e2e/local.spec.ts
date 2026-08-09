import { expect, test, type Page } from "@playwright/test";

/** Cells expose their state through aria-label, which doubles as the test handle. */
const cell = (page: Page, row: number, col: number) =>
  page.getByRole("button", { name: new RegExp(`^Row ${row + 1}, column ${col + 1}:`) });

async function startBattle(page: Page) {
  await page.goto("/local");
  await page.getByRole("button", { name: "Start Battle" }).first().click();
  await expect(page.getByRole("heading", { name: /controls the next move/ })).toBeVisible();
}

test.describe("local arena", () => {
  test("loads with an empty board and a setup panel", async ({ page }) => {
    await page.goto("/local");

    await expect(page.getByRole("heading", { name: "Local Arena" })).toBeVisible();
    await expect(page.getByLabel("Board Preset")).toBeVisible();
    await expect(cell(page, 0, 0)).toHaveAccessibleName(/empty$/);
  });

  test("places an orb and advances the turn", async ({ page }) => {
    await startBattle(page);
    await expect(page.getByRole("heading", { name: /Player 1 controls the next move/ })).toBeVisible();

    await cell(page, 2, 2).click();

    await expect(cell(page, 2, 2)).toHaveAccessibleName(/1 orb owned by Player 1$/);
    await expect(page.getByRole("heading", { name: /Player 2 controls the next move/ })).toBeVisible();
  });

  test("explodes a corner on the second placement and converts neighbours", async ({ page }) => {
    await startBattle(page);

    await cell(page, 0, 0).click(); // Player 1 claims the corner
    await cell(page, 5, 5).click(); // Player 2 plays far away
    await cell(page, 0, 0).click(); // Player 1 reaches critical mass at a corner

    // The corner empties and hands one orb to each orthogonal neighbour.
    await expect(cell(page, 0, 0)).toHaveAccessibleName(/empty$/);
    await expect(cell(page, 0, 1)).toHaveAccessibleName(/1 orb owned by Player 1$/);
    await expect(cell(page, 1, 0)).toHaveAccessibleName(/1 orb owned by Player 1$/);
  });

  test("refuses to play onto an opponent's cell", async ({ page }) => {
    await startBattle(page);

    await cell(page, 3, 3).click(); // Player 1
    // Player 2 cannot take it, so the control is disabled rather than merely inert.
    await expect(cell(page, 3, 3)).toBeDisabled();
  });

  test("board stays inside the viewport on a phone", async ({ page }) => {
    await startBattle(page);

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(overflows).toBe(false);
  });

  test("the board is the first thing on screen once play starts", async ({ page }, testInfo) => {
    await startBattle(page);

    const board = page.locator(".board");
    const box = await board.boundingBox();
    expect(box).not.toBeNull();

    // The board must be reachable without scrolling. It used to sit below the
    // setup panel and a half-empty metrics block on a phone, and below the fold
    // entirely on a 950px-tall desktop window.
    const viewportHeight = page.viewportSize()?.height ?? 0;
    expect(box!.y, `board pushed below the fold on ${testInfo.project.name}`).toBeLessThan(viewportHeight * 0.55);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight + 1);
  });

  test("turn countdown is shown and stat labels sit above their values", async ({ page }) => {
    await startBattle(page);

    await expect(page.getByText(/^\d+s left this turn$/)).toBeVisible();

    // Regression: the label and value were both inline elements, so they rendered
    // as "CurrentPlayer 1". Asserted geometrically — textContent is identical
    // either way, so only the layout can tell the difference.
    //
    // Polled rather than measured once: the panel animates in, and a single
    // reading can land mid-transition.
    const statBox = page.locator(".stat-box").filter({ hasText: "Current" }).first();

    await expect
      .poll(
        async () => {
          const label = await statBox.locator(".stat-label").boundingBox();
          const value = await statBox.locator("strong").boundingBox();
          if (!label || !value) return null;
          return value.y >= label.y + label.height - 1;
        },
        { message: "value should start below the label, not beside it" }
      )
      .toBe(true);
  });
});
