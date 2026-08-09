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
});
