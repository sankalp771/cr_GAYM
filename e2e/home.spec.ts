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

  test("does not scroll horizontally on a phone", async ({ page }) => {
    await page.goto("/");

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(overflows).toBe(false);
  });
});
