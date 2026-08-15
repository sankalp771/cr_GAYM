import { expect, test } from "@playwright/test";

test.describe("home", () => {
  test("loads and offers both modes", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Play Local" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Play Online" })).toBeVisible();
  });

  test("links through to local mode", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Play Local" }).click();

    await expect(page).toHaveURL(/\/local$/);
    await expect(page.getByRole("heading", { name: "Local Arena" })).toBeVisible();
  });

  test("links through to multiplayer", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Create or join a room" }).click();

    await expect(page).toHaveURL(/\/multiplayer$/);
  });

  test("hero copy is readable and the demo board has not blown up", async ({ page }) => {
    await page.goto("/");

    // Regression guard. A `.burst` rule added for the arena's explosion
    // particles once collided with this page's `.preview-cell.burst` modifier:
    // every preview cell became position:absolute; inset:0, stretched to fill
    // the hero, and the blurred glow inside it swallowed the page. Nothing
    // caught it because no test looked at this page's layout.
    //
    // The styles are CSS Modules now, so that exact collision cannot recur —
    // but "a cell escaped its grid and ate the hero" is the class of bug worth
    // keeping a tripwire on, whatever causes it next.
    //
    // Measured against the board rather than the hero, because the board is
    // *meant* to be nearly full width once the hero stacks on a phone. An
    // earlier version of this check compared against the hero and failed on
    // both phone viewports for a page that was rendering perfectly.
    const demo = await page.getByTestId("demo-board").boundingBox();
    expect(demo).not.toBeNull();

    // Six columns, so a cell is about a sixth of the board. A third is a loose
    // bound that still catches a cell that has broken out of the grid.
    const widestCell = await page
      .getByTestId("demo-cell")
      .evaluateAll((nodes) => Math.max(...nodes.map((node) => node.getBoundingClientRect().width)));

    expect(widestCell, "demo cells should be small tiles, not stretched across the board").toBeLessThan(
      demo!.width / 3
    );

    // It is a square board in a square frame. If either axis runs away, the
    // aspect ratio is the first thing to notice.
    const ratio = demo!.width / demo!.height;
    expect(ratio, "the demo board should stay roughly square").toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.4);

    // And it must never be wider than the page that contains it.
    const viewport = page.viewportSize();
    expect(demo!.width).toBeLessThanOrEqual(viewport!.width);

    await expect(page.getByRole("heading", { name: /Take the whole board/ })).toBeVisible();
    await expect(page.getByText(/Fill a cell past the number of neighbours/)).toBeVisible();
  });

  test("explains the rules", async ({ page }) => {
    await page.goto("/");

    // A first-time visitor should be able to learn the game without leaving.
    await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overload it" })).toBeVisible();
  });

  test("does not scroll horizontally on a phone", async ({ page }) => {
    await page.goto("/");

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(overflows).toBe(false);
  });
});
