import { expect, test, type Page } from "@playwright/test";

/** Cells expose their state through aria-label, which doubles as the test handle. */
const cell = (page: Page, row: number, col: number) =>
  page.getByRole("button", { name: new RegExp(`^Row ${row + 1}, column ${col + 1}:`) });

const board = (page: Page) => page.getByTestId("board");

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

async function startBattle(page: Page, { allHuman = true } = {}) {
  await page.goto("/local");
  if (allHuman) await setAllSeatsToHuman(page);
  await page.getByRole("button", { name: "Start Battle" }).click();
  await expect(board(page)).toBeVisible();
}

test.describe("local — setup screen", () => {
  test("shows the setup form and no board", async ({ page }) => {
    await page.goto("/local");

    await expect(page.getByRole("heading", { name: "Local Arena" })).toBeVisible();
    await expect(page.getByLabel("Board Preset")).toBeVisible();
    await expect(page.getByLabel("Players")).toBeVisible();
    // Setup and the match are separate screens; the board belongs to the match.
    await expect(board(page)).toHaveCount(0);
  });

  test("bot difficulty and sound live in settings and persist", async ({ page }) => {
    await page.goto("/local");

    const settings = page.getByRole("button", { name: "Settings" });
    await settings.click();
    await expect(settings).toHaveAttribute("aria-expanded", "true");

    // Four rungs, weakest first. Expert is the depth search; the other three are
    // one heuristic at three honesties.
    await expect(page.getByRole("radio")).toHaveCount(4);
    for (const level of ["Easy", "Normal", "Hard", "Expert"]) {
      await expect(page.getByRole("radio", { name: level })).toBeVisible();
    }

    // Normal is the default: `hard` wins ~98% of games against random play,
    // which is no way to meet the game for the first time.
    await expect(page.getByRole("radio", { name: "Normal" })).toBeChecked();
    await page.getByRole("radio", { name: "Easy" }).check();

    const sound = page.getByRole("checkbox", { name: "Sound effects" });
    await expect(sound).toBeChecked();
    await sound.uncheck();

    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("radio", { name: "Easy" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Sound effects" })).not.toBeChecked();
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
});

test.describe("local — match screen", () => {
  test("places an orb and advances the turn", async ({ page }) => {
    await startBattle(page);
    await expect(page.getByText("Player 1 to move")).toBeVisible();

    await cell(page, 2, 2).click();

    await expect(cell(page, 2, 2)).toHaveAccessibleName(/1 orb owned by Player 1$/);
    await expect(page.getByText("Player 2 to move")).toBeVisible();
  });

  test("explodes a corner on the second placement and converts neighbours", async ({ page }) => {
    await startBattle(page);

    await cell(page, 0, 0).click(); // Player 1 claims the corner
    await cell(page, 5, 5).click(); // Player 2 plays far away
    await cell(page, 0, 0).click(); // Player 1 reaches critical mass at a corner

    await expect(cell(page, 0, 0)).toHaveAccessibleName(/empty$/);
    await expect(cell(page, 0, 1)).toHaveAccessibleName(/1 orb owned by Player 1$/);
    await expect(cell(page, 1, 0)).toHaveAccessibleName(/1 orb owned by Player 1$/);
  });

  test("emits explosion particles during a cascade", async ({ page }) => {
    await startBattle(page);

    // A burst is on screen for barely a hundred milliseconds, so polling for it
    // would be a coin flip. A MutationObserver cannot miss the window.
    await page.evaluate(() => {
      const win = window as unknown as { __sawBurst?: boolean };
      win.__sawBurst = false;
      new MutationObserver(() => {
        if (document.querySelector("[data-direction]")) win.__sawBurst = true;
      }).observe(document.body, { childList: true, subtree: true });
    });

    await cell(page, 0, 0).click();
    await cell(page, 5, 5).click();
    await cell(page, 0, 0).click();

    await expect(cell(page, 0, 1)).toHaveAccessibleName(/1 orb owned by Player 1$/);

    const sawBurst = await page.evaluate(() => (window as unknown as { __sawBurst?: boolean }).__sawBurst);
    expect(sawBurst, "no explosion particles were rendered during the cascade").toBe(true);
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
    await page.getByRole("button", { name: "Start Battle" }).click();
    await expect(board(page)).toBeVisible();

    // Orbs are all the same sphere, as in the original game, so colour is the
    // only channel telling players apart — every seat must get its own.
    const colors = await page
      .getByTestId("player-dot")
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node as HTMLElement).backgroundColor));

    expect(colors).toHaveLength(4);
    expect(new Set(colors).size, `expected 4 distinct colours, got ${colors.join(", ")}`).toBe(4);
  });

  test("an expert computer answers a human move", async ({ page }) => {
    // The search is exercised hard in the unit suite; what this adds is the one
    // thing Node cannot tell us — that it runs inside a real browser on the main
    // thread without hanging the page. Seats default to one human and computers
    // for the rest, so player 2 is already a bot.
    await page.goto("/local");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("radio", { name: "Expert" }).check();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Start Battle" }).click();
    await expect(board(page)).toBeVisible();
    await expect(page.getByText("Player 1 to move")).toBeVisible();

    await cell(page, 2, 2).click();

    // The bot owning a cell is proof it moved; the turn indicator alone would
    // flicker past too quickly to assert on reliably.
    await expect(page.getByRole("button", { name: /owned by Player 2$/ }).first()).toBeVisible({
      timeout: 15_000
    });
    await expect(page.getByText("Player 1 to move")).toBeVisible({ timeout: 15_000 });
  });

  test("leaving the match returns to setup", async ({ page }) => {
    await startBattle(page);
    await page.getByRole("button", { name: "Leave match" }).click();

    await expect(page.getByLabel("Board Preset")).toBeVisible();
    await expect(board(page)).toHaveCount(0);
  });

  test("the whole board stays on screen at every seat count", async ({ page }, testInfo) => {
    // Regression: setup used to share the screen with the board, so its column
    // grew with the seat count — 525px at 2 seats, 1116px at 8 — dragged the
    // page taller, and pushed the board off the bottom. At 8 seats the board
    // also stopped being square.
    for (const seats of [2, 4, 6, 8]) {
      await page.goto("/local");
      await page.getByLabel("Players").selectOption(String(seats));
      await page.getByRole("button", { name: "Start Battle" }).click();
      await expect(board(page)).toBeVisible();

      const box = await board(page).boundingBox();
      expect(box).not.toBeNull();

      const where = `${seats} seats on ${testInfo.project.name}`;
      expect(Math.abs(box!.width - box!.height), `board is not square with ${where}`).toBeLessThan(2);

      const viewport = page.viewportSize()!;
      expect(box!.y, `board starts above the viewport with ${where}`).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height, `board runs past the fold with ${where}`).toBeLessThanOrEqual(
        viewport.height + 1
      );

      const pageScrolls = await page.evaluate(
        () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
      );
      expect(pageScrolls, `page scrolls with ${where}`).toBe(false);
    }
  });

  test("the board takes a serious share of the screen", async ({ page }, testInfo) => {
    // The point of splitting the screens: the board is the content, not a panel
    // squeezed between chrome. It had shrunk to 255px on a short laptop.
    await startBattle(page);

    const box = await board(page).boundingBox();
    const viewport = page.viewportSize()!;
    const shorterSide = Math.min(viewport.width, viewport.height);

    expect(
      box!.height / shorterSide,
      `board is only ${Math.round(box!.height)}px on a ${shorterSide}px axis (${testInfo.project.name})`
    ).toBeGreaterThan(0.55);
  });
});
