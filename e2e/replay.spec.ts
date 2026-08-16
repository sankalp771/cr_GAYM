import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const cell = (page: Page, row: number, col: number) =>
  page.getByRole("button", { name: new RegExp(`^Row ${row + 1}, column ${col + 1}:`) });

/**
 * The shortest match this game allows: three moves.
 *
 * Player 1 loads a corner, player 2 puts its only orb next door, and the corner
 * goes off — converting that orb and leaving player 2 with nothing while it has
 * already taken a turn, which is exactly the elimination rule. Playing a real
 * match out would take a minute per device profile; this takes three clicks and
 * still exercises a cascade, an elimination and the winner's flourish.
 */
async function playShortestMatch(page: Page) {
  await page.goto("/local");

  const controls = page.getByLabel(/^Player \d+ control$/);
  const seats = await controls.count();
  for (let seat = 0; seat < seats; seat += 1) await controls.nth(seat).selectOption("human");

  await page.getByRole("button", { name: "Start Battle" }).click();
  await expect(page.getByTestId("board")).toBeVisible();

  await cell(page, 0, 0).click();
  await cell(page, 0, 1).click();
  await cell(page, 0, 0).click();

  await expect(page.getByRole("dialog", { name: "Match result" })).toBeVisible({ timeout: 15_000 });
}

test.describe("replay", () => {
  test("offers the match back when it ends", async ({ page }) => {
    await playShortestMatch(page);

    const dialog = page.getByRole("dialog", { name: "Match result" });
    await expect(dialog.getByRole("button", { name: "Watch replay" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Download replay" })).toBeVisible();

    // The modal can be dismissed, so the offer also has to survive on its own.
    await dialog.getByRole("button", { name: "Rematch" }).isVisible();
    await page.keyboard.press("Escape");
  });

  test("plays the match back move by move and closes again", async ({ page }) => {
    await playShortestMatch(page);
    await page.getByRole("dialog").getByRole("button", { name: "Watch replay" }).click();

    const position = page.getByTestId("replay-position");
    await expect(position).toBeVisible();

    // It opens playing, so park it before stepping.
    await page.getByRole("button", { name: "Pause" }).click();
    await page.getByRole("button", { name: "Back to the start" }).click();
    await expect(position).toHaveText("Move 0 / 3");

    await page.getByRole("button", { name: "Next move" }).click();
    await expect(position).toHaveText("Move 1 / 3");
    await page.getByRole("button", { name: "Next move" }).click();
    await expect(position).toHaveText("Move 2 / 3");

    await page.getByRole("button", { name: "Jump to the end" }).click();
    await expect(page.getByText("Match over")).toBeVisible();

    await page.getByRole("button", { name: "Close replay" }).click();
    await expect(page.getByRole("dialog", { name: "Match result" })).toBeVisible();
  });

  test("downloads a replay that stands on its own", async ({ page }) => {
    await playShortestMatch(page);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("dialog").getByRole("button", { name: "Download replay" }).click()
    ]);

    expect(download.suggestedFilename()).toMatch(/^chain-reaction-local-\d{4}-\d{2}-\d{2}-\d{4}\.html$/);

    const saved = await download.path();
    const html = readFileSync(saved, "utf8");

    // The file has to open on a machine with no network and no copy of this app.
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('id="replay-data"');
    expect(html).not.toMatch(/(src|href)\s*=\s*["']https?:/i);
  });

  test("the downloaded file plays in a browser of its own", async ({ page }, testInfo) => {
    await playShortestMatch(page);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("dialog").getByRole("button", { name: "Download replay" }).click()
    ]);

    // Saved under its own name: the browser decides what a file is from its
    // extension, and Playwright's scratch copy has none.
    const saved = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(saved);
    await page.goto(pathToFileURL(saved).href);

    await expect(page.locator("#readout")).toHaveText("Move 0 / 3");
    await page.locator("#next").click();
    await expect(page.locator("#readout")).toHaveText("Move 1 / 3");

    await page.locator("#end").click();
    await expect(page.locator("#status")).toContainText("wins.");
  });
});
