import { expect, test, type Page } from "@playwright/test";

/**
 * A name nobody has registered before.
 *
 * The account server keeps its rows in a Durable Object that survives between
 * runs, so a fixed name would pass once and then fail with "already registered"
 * for the rest of the repository's life. Names cap at 16 characters, so this is
 * a short prefix and a base-36 clock.
 */
function freshName(prefix: string): string {
  return `${prefix}${Date.now().toString(36).slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
}

const PASSWORD = "correct horse battery";

async function registerOn(page: Page, name: string) {
  await page.goto("/multiplayer");
  await page.getByRole("button", { name: "Register instead" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Register", exact: true }).click();

  // PBKDF2 runs in the browser before anything is sent, so this is slower than
  // a form post — see lib/auth/crypto.ts for why that work lives there.
  await expect(page.getByTestId("account-chip")).toBeVisible({ timeout: 20_000 });
}

test.describe("accounts", () => {
  test("registers a name, and says who you are", async ({ page }) => {
    const name = freshName("reg");
    await registerOn(page, name);

    const chip = page.getByTestId("account-chip");
    await expect(chip).toContainText(name);
    await expect(chip).toContainText("Registered");
    // A registered name is the server's to decide, so the field stops being editable.
    await expect(page.getByLabel("Your name")).toHaveValue(name);
    await expect(page.getByLabel("Your name")).toHaveAttribute("readonly", "");
  });

  test("stays signed in across a reload, and signs out on request", async ({ page }) => {
    const name = freshName("stay");
    await registerOn(page, name);

    await page.reload();
    await expect(page.getByTestId("account-chip")).toContainText(name, { timeout: 20_000 });

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByTestId("account-panel")).toBeVisible();
    await expect(page.getByTestId("account-chip")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("account-panel")).toBeVisible();
  });

  test("signs back in with the same password, and refuses a wrong one", async ({ page }) => {
    const name = freshName("back");
    await registerOn(page, name);
    await page.getByRole("button", { name: "Sign out" }).click();

    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Password", { exact: true }).fill("not the password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByTestId("account-error")).toContainText("do not match", { timeout: 20_000 });

    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByTestId("account-chip")).toContainText(name, { timeout: 20_000 });
  });

  test("will not register a name that is already taken", async ({ page }) => {
    const name = freshName("dup");
    await registerOn(page, name);
    await page.getByRole("button", { name: "Sign out" }).click();

    await page.getByRole("button", { name: "Register instead" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name.toUpperCase());
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Register", exact: true }).click();

    // Upper-cased on purpose: names fold to one identity, so this is the same name.
    await expect(page.getByTestId("account-error")).toContainText("already registered", { timeout: 20_000 });
  });

  test("marks a signed-in player's seat as registered", async ({ page }) => {
    const name = freshName("seat");
    await registerOn(page, name);

    await page.getByRole("button", { name: "Create Room" }).click();
    const seat = page.getByTestId("lobby-seat").first();
    await expect(seat).toContainText(name, { timeout: 20_000 });
    await expect(seat).toContainText("Registered");
  });

  test("a guest cannot wear a registered name", async ({ page, browser }) => {
    const name = freshName("mine");
    await registerOn(page, name);

    // A second browser with no session at all — the impersonation attempt.
    const context = await browser.newContext();
    const guest = await context.newPage();
    await guest.goto("/multiplayer");
    await expect(guest.getByTestId("account-panel")).toBeVisible();

    // Spelled differently on purpose: names fold, so this is the same identity
    // and must be refused just as the exact spelling would be.
    await guest.getByLabel("Your name").fill(name.toUpperCase());
    await guest.getByRole("button", { name: "Create Room" }).click();

    await expect(guest.getByTestId("room-error")).toContainText("registered", { timeout: 20_000 });
    // And they got no seat, rather than a seat under somebody else's name.
    await expect(guest.getByTestId("lobby-seat").first()).toContainText("Empty seat");

    await context.close();
  });

  test("a guest keeps playing under any unclaimed name", async ({ page }) => {
    // The point of the whole feature is that it changes nothing for guests.
    await page.goto("/multiplayer");
    await page.getByLabel("Your name").fill(freshName("free"));
    await page.getByRole("button", { name: "Create Room" }).click();

    await expect(page.getByTestId("lobby-seat").first()).not.toContainText("Empty seat", {
      timeout: 20_000
    });
    await expect(page.getByTestId("room-error")).toHaveCount(0);
  });
});
