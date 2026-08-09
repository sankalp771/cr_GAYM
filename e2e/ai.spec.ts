import { expect, test, type Page } from "@playwright/test";

/** Cells expose their state through aria-label, which doubles as the test handle. */
const cell = (page: Page, row: number, col: number) =>
  page.getByRole("button", { name: new RegExp(`^Row ${row + 1}, column ${col + 1}:`) });

/**
 * Total orbs on the board.
 *
 * Explosions conserve orbs and the grid has no sink, so this is exactly the
 * number of moves played so far — which makes it the cheapest way to tell that
 * every bot in a queue has actually taken its turn, cascade or no cascade.
 */
const orbCount = (page: Page) => page.locator(".board .orb").count();

const turnHeading = (page: Page, name: string) =>
  page.getByRole("heading", { name: new RegExp(`^${name} controls the next move$`) });

/** A bot waits ~600ms before committing, then its cascade animates. Seven of them add up. */
const botTurnBudgetMs = 12_000;

test.describe("computer opponents", () => {
  test("defaults to one human and fills the remaining seats with computers", async ({ page }) => {
    await page.goto("/local");

    await expect(page.getByLabel("Player 1 control")).toHaveValue("human");
    await expect(page.getByLabel("Player 2 control")).toHaveValue("computer");

    await page.getByLabel("Players").selectOption("5");
    for (const seat of [2, 3, 4, 5]) {
      await expect(page.getByLabel(`Player ${seat} control`)).toHaveValue("computer");
    }
    await expect(page.getByLabel("Player 1 control")).toHaveValue("human");
  });

  test("one computer opponent replies and hands the turn back", async ({ page }) => {
    await page.goto("/local");
    await page.getByRole("button", { name: "Start Battle" }).first().click();

    await expect(turnHeading(page, "Player 1")).toBeVisible();
    // The seat is marked as a bot in the lineup, not just in the setup panel.
    await expect(page.locator(".player-line", { hasText: "Player 2" }).locator(".ai-badge")).toHaveText("CPU");

    await cell(page, 2, 2).click();
    await expect(cell(page, 2, 2)).toHaveAccessibleName(/1 orb owned by Player 1$/);

    // Two orbs on the board means the bot has played its own move.
    await expect.poll(() => orbCount(page), { timeout: botTurnBudgetMs }).toBe(2);

    await expect(turnHeading(page, "Player 1")).toBeVisible({ timeout: botTurnBudgetMs });
    await expect(page.locator(".board button.playable").first()).toBeEnabled();
  });

  test("seven computer opponents all play before the turn returns to the human", async ({ page }) => {
    // Seven bots, each pausing before it moves and then animating its cascade.
    test.setTimeout(90_000);

    await page.goto("/local");
    await page.getByLabel("Players").selectOption("8");
    await page.getByRole("button", { name: "Start Battle" }).first().click();

    await expect(turnHeading(page, "Player 1")).toBeVisible();
    await expect(page.locator(".player-line .ai-badge")).toHaveCount(7);

    await cell(page, 2, 2).click();

    // One orb per move played, so eight is the human plus all seven bots.
    await expect.poll(() => orbCount(page), { timeout: 60_000 }).toBe(8);

    await expect(turnHeading(page, "Player 1")).toBeVisible({ timeout: botTurnBudgetMs });
    await expect(page.locator(".board button.playable").first()).toBeEnabled();
  });

  test("a bot takes exactly one turn, never two in a row", async ({ page }) => {
    // Regression guard for the latch: the AI is dispatched from an effect that
    // re-runs on every state change, so without it a bot plays twice and the
    // human's turn is skipped.
    await page.goto("/local");
    await page.getByLabel("Players").selectOption("3");
    await page.getByRole("button", { name: "Start Battle" }).first().click();

    await expect(turnHeading(page, "Player 1")).toBeVisible();
    await cell(page, 2, 2).click();

    await expect.poll(() => orbCount(page), { timeout: botTurnBudgetMs }).toBe(3);
    await expect(turnHeading(page, "Player 1")).toBeVisible({ timeout: botTurnBudgetMs });

    // Give the bots a further beat with nothing to do. If either could fire
    // twice for one turn, a fourth orb would appear here.
    await page.waitForTimeout(1_500);
    expect(await orbCount(page)).toBe(3);
    await expect(turnHeading(page, "Player 1")).toBeVisible();
  });

  test("all-human seats leave the board alone", async ({ page }) => {
    // The opposite guard: nothing should move on its own when no seat is a bot.
    await page.goto("/local");
    await page.getByLabel("Player 2 control").selectOption("human");
    await page.getByRole("button", { name: "Start Battle" }).first().click();

    await expect(turnHeading(page, "Player 1")).toBeVisible();
    await expect(page.locator(".player-line .ai-badge")).toHaveCount(0);

    await cell(page, 2, 2).click();
    await expect(turnHeading(page, "Player 2")).toBeVisible();

    await page.waitForTimeout(1_500);
    expect(await orbCount(page)).toBe(1);
    await expect(turnHeading(page, "Player 2")).toBeVisible();
  });
});
