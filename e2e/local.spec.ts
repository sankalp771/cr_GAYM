import { expect, test, type Page } from "@playwright/test";

/** Cells expose their state through aria-label, which doubles as the test handle. */
const cell = (page: Page, row: number, col: number) =>
  page.getByRole("button", { name: new RegExp(`^Row ${row + 1}, column ${col + 1}:`) });

/**
 * Hand every seat to a human.
 *
 * Seats default to one human and the rest computers, so a hot-seat test has to
 * say so explicitly — otherwise a bot would take the moves these specs make on
 * behalf of players 2 and up.
 */
async function setAllSeatsToHuman(page: Page) {
  const controls = page.getByLabel(/^Player \d+ control$/);
  const count = await controls.count();
  for (let seat = 0; seat < count; seat += 1) {
    await controls.nth(seat).selectOption("human");
  }
}

async function startBattle(page: Page) {
  await page.goto("/local");
  await setAllSeatsToHuman(page);
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

  test("emits explosion particles during a cascade", async ({ page }) => {
    await startBattle(page);

    // A burst is on screen for barely a hundred milliseconds, so polling for it
    // would be a coin flip. Record via MutationObserver instead: it cannot miss
    // the window however the frames happen to land.
    await page.evaluate(() => {
      const win = window as unknown as { __sawBurst?: boolean };
      win.__sawBurst = false;
      new MutationObserver(() => {
        if (document.querySelector(".orb-burst-particle")) win.__sawBurst = true;
      }).observe(document.body, { childList: true, subtree: true });
    });

    await cell(page, 0, 0).click();
    await cell(page, 5, 5).click();
    await cell(page, 0, 0).click(); // corner reaches critical mass

    await expect(cell(page, 0, 1)).toHaveAccessibleName(/1 orb owned by Player 1$/);

    const sawBurst = await page.evaluate(() => (window as unknown as { __sawBurst?: boolean }).__sawBurst);
    expect(sawBurst, "no explosion particles were rendered during the cascade").toBe(true);
  });

  test("sound can be muted from settings and the choice persists", async ({ page }) => {
    await page.goto("/local");

    await page.getByRole("button", { name: "Settings" }).click();
    const sound = page.getByRole("checkbox", { name: /Sound effects/ });
    await expect(sound).toBeChecked();

    await sound.uncheck();
    await expect(sound).not.toBeChecked();

    // The preference is stored, so a reload keeps the choice.
    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("checkbox", { name: /Sound effects/ })).not.toBeChecked();
  });

  test("bot difficulty can be chosen from settings and persists", async ({ page }) => {
    await page.goto("/local");

    const settings = page.getByRole("button", { name: "Settings" });
    await settings.click();
    await expect(settings).toHaveAttribute("aria-expanded", "true");

    // Normal is the default: the greedy heuristic wins ~98% of games against
    // random play, which is no way to meet the game for the first time.
    await expect(page.getByRole("radio", { name: /Normal/ })).toBeChecked();

    await page.getByRole("radio", { name: /Easy/ }).check();
    await expect(page.getByRole("radio", { name: /Easy/ })).toBeChecked();

    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("radio", { name: /Easy/ })).toBeChecked();
  });

  test("settings popover closes on Escape and returns focus to its trigger", async ({ page }) => {
    await page.goto("/local");

    const settings = page.getByRole("button", { name: "Settings" });
    await settings.click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    // Focus must come back, or a keyboard user is stranded on a removed node.
    await expect(settings).toBeFocused();
  });

  test("settings popover is not clipped by the header card", async ({ page }) => {
    await page.goto("/local");
    await page.getByRole("button", { name: "Settings" }).click();

    // The shared card style sets overflow:hidden; the panel hangs below the
    // header and would be cut in half without an explicit override.
    const panel = await page.getByRole("dialog", { name: "Settings" }).boundingBox();
    const header = await page.locator(".local-header-card").boundingBox();

    expect(panel).not.toBeNull();
    expect(header).not.toBeNull();
    expect(panel!.height, "settings panel looks collapsed or clipped").toBeGreaterThan(180);
    expect(
      panel!.y + panel!.height,
      "panel should extend past the header, proving it is not clipped"
    ).toBeGreaterThan(header!.y + header!.height);
  });

  test("refuses to play onto an opponent's cell", async ({ page }) => {
    await startBattle(page);

    await cell(page, 3, 3).click(); // Player 1
    // Player 2 cannot take it, so the control is disabled rather than merely inert.
    await expect(cell(page, 3, 3)).toBeDisabled();
  });

  test("gives every player a distinct colour", async ({ page }) => {
    await page.goto("/local");
    await page.getByLabel("Players").selectOption("4");
    await page.getByRole("button", { name: "Start Battle" }).first().click();
    await expect(page.getByRole("heading", { name: /controls the next move/ })).toBeVisible();

    // Orbs are all the same sphere, as in the original game, so colour is the
    // only channel telling players apart — every seat must get its own.
    const colors = await page.locator(".player-line .player-dot").evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node as HTMLElement).backgroundColor)
    );

    expect(colors).toHaveLength(4);
    expect(new Set(colors).size, `expected 4 distinct colours, got ${colors.join(", ")}`).toBe(4);
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

  test("the whole board stays on screen at every seat count", async ({ page }, testInfo) => {
    // Regression: the setup column grew with the seat count — 525px at 2 seats,
    // 1116px at 8 — and dragged the page taller, pushing the board off the
    // bottom. The board also stopped being square at 8 seats. The cause was a
    // shell with only `min-height`, leaving its height indefinite, so every
    // percentage height below it silently resolved to `auto`.
    for (const seats of [2, 4, 6, 8]) {
      await page.goto("/local");
      await page.getByLabel("Players").selectOption(String(seats));
      await page.getByRole("button", { name: "Start Battle" }).first().click();
      await expect(page.getByRole("heading", { name: /controls the next move/ })).toBeVisible();

      const box = await page.locator(".board").boundingBox();
      expect(box).not.toBeNull();

      const where = `${seats} seats on ${testInfo.project.name}`;
      expect(Math.abs(box!.width - box!.height), `board is not square with ${where}`).toBeLessThan(2);

      const viewport = page.viewportSize();
      if (viewport && viewport.width > 980) {
        // Desktop pins the arena to one viewport: the board must fit entirely,
        // and the page must not scroll to reach it.
        expect(box!.y, `board starts above the viewport with ${where}`).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height, `board runs past the fold with ${where}`).toBeLessThanOrEqual(
          viewport.height + 1
        );

        const pageScrolls = await page.evaluate(
          () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
        );
        expect(pageScrolls, `page scrolls vertically with ${where}`).toBe(false);
      }
    }
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
