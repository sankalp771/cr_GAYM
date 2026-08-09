import { expect, test } from "@playwright/test";

test.describe("home", () => {
  test("loads and offers both modes", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Launch Local Battle" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Multiplayer Lab" })).toBeVisible();
  });

  test("links through to local mode", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Launch Local Battle" }).click();

    await expect(page).toHaveURL(/\/local$/);
    await expect(page.getByRole("heading", { name: "Local Arena" })).toBeVisible();
  });

  test("hero copy is readable and the preview board is not blown up", async ({ page }) => {
    await page.goto("/");

    // Regression: a `.burst` rule added for the arena's explosion particles
    // collided with the landing page's `.preview-cell.burst` modifier. Each
    // preview cell became position:absolute; inset:0, stretched to fill
    // .hero-card, and the blurred glow inside it swallowed the whole hero.
    // Nothing caught it because no test looked at this page's layout.
    const hero = await page.locator(".hero-card").boundingBox();
    expect(hero).not.toBeNull();

    // Measure the WIDEST cell, not the first. Only 8 of the 36 carry the `burst`
    // modifier, and cell 0 is not one of them — checking `.first()` here passed
    // happily while the bug was reintroduced.
    const widestCell = await page.locator(".preview-cell").evaluateAll((nodes) =>
      Math.max(...nodes.map((node) => node.getBoundingClientRect().width))
    );

    expect(
      widestCell,
      "preview cells should be small tiles, not stretched across the hero"
    ).toBeLessThan(hero!.width / 4);

    await expect(page.getByRole("heading", { name: /Neon Battles/ })).toBeVisible();
    await expect(page.getByText(/A premium competitive take on Chain Reaction/)).toBeVisible();
  });

  test("does not scroll horizontally on a phone", async ({ page }) => {
    await page.goto("/");

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(overflows).toBe(false);
  });
});
