import { expect, test, type Page } from "@playwright/test";

/**
 * Online play, driven through two independent browser contexts.
 *
 * Two contexts rather than two tabs: each gets its own `localStorage`, so each
 * gets its own session token, which is exactly what makes them two players
 * rather than one player reconnecting.
 */

/** A lobby seat addressed by the name shown on it. */
const seat = (page: Page, name: string) =>
  page.getByTestId("lobby-seat").filter({ hasText: new RegExp(`^${name}`) });

const cell = (page: Page, row: number, col: number) =>
  page.getByRole("button", { name: new RegExp(`^Row ${row + 1}, column ${col + 1}:`) });

async function createRoom(page: Page, name: string) {
  await page.goto("/multiplayer");
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Create Room" }).click();
  await expect(page.getByTestId("room-code")).toBeVisible();
  return (await page.getByTestId("room-code").innerText()).trim();
}

async function joinRoom(page: Page, name: string, code: string) {
  await page.goto("/multiplayer");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Room code").fill(code);
  await page.getByRole("button", { name: "Join Room" }).click();
}

test.describe("multiplayer", () => {
  test("two players share a room, take turns, and see the same board", async ({ browser }) => {
    test.setTimeout(90_000);

    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    const code = await createRoom(host, "Ana");
    expect(code).toMatch(/^[A-Z0-9]{6}$/);

    await joinRoom(guest, "Bo", code);

    // Both sides converge on the same lobby.
    await expect(seat(host, "Bo")).toBeVisible();
    await expect(seat(guest, "Ana")).toBeVisible();

    // The host cannot start until the guest is ready — the rule lives on the
    // server, so this also proves the client is not inventing permission.
    await guest.getByRole("button", { name: "I'm ready" }).click();
    await expect(host.getByText("Everyone is ready. Start when you like.")).toBeVisible();

    await host.getByRole("button", { name: "Start Match" }).click();

    await expect(host.getByTestId("board")).toBeVisible();
    await expect(guest.getByTestId("board")).toBeVisible();

    // Seat order decides who opens, and both clients must agree about it.
    await expect(host.getByText("Your turn")).toBeVisible();
    await expect(guest.getByText("Ana to move")).toBeVisible();

    // The guest's board is not theirs to touch yet.
    await expect(guest.locator('[data-testid="board"] button:not([disabled])')).toHaveCount(0);

    await cell(host, 2, 2).click();

    // The move is authoritative: it shows up on the other device.
    await expect(cell(guest, 2, 2)).toHaveAccessibleName(/1 orb owned by Ana$/, { timeout: 15_000 });
    await expect(cell(host, 2, 2)).toHaveAccessibleName(/1 orb owned by Ana$/);
    await expect(guest.getByText("Your turn")).toBeVisible();

    await cell(guest, 5, 5).click();
    await expect(cell(host, 5, 5)).toHaveAccessibleName(/1 orb owned by Bo$/, { timeout: 15_000 });
    await expect(host.getByText("Your turn")).toBeVisible();

    await hostContext.close();
    await guestContext.close();
  });

  test("a mistyped room code does not strand you in an empty room", async ({ page }) => {
    // Joining an unknown code used to create one silently, which looks identical
    // to a room your friend is in — except nobody is ever coming.
    await page.goto("/multiplayer");
    await page.getByLabel("Your name").fill("Lost");
    await page.getByLabel("Room code").fill("ZZZZZZ");
    await page.getByRole("button", { name: "Join Room" }).click();

    // Scoped to the lobby's own alert: Next renders a route announcer that also
    // carries role="alert", so the bare role matches two nodes.
    await expect(page.getByTestId("room-error")).toContainText(/No room with that code/i, {
      timeout: 15_000
    });
  });

  test("rejects a room code that is not six characters", async ({ page }) => {
    await page.goto("/multiplayer");
    await page.getByLabel("Room code").fill("ABC");
    await page.getByRole("button", { name: "Join Room" }).click();
    await expect(page.getByText(/6 letters and numbers/i)).toBeVisible();
  });

  test("a player who reloads keeps their seat", async ({ browser }) => {
    test.setTimeout(90_000);

    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    const code = await createRoom(host, "Ana");
    await joinRoom(guest, "Bo", code);
    await expect(seat(host, "Bo")).toBeVisible();

    // The session token lives in localStorage, so the same context reloading is
    // the same player — not a second one taking another seat.
    await guest.reload();
    await expect(guest.getByTestId("room-code")).toHaveText(code);
    await expect(host.getByTestId("lobby-seat")).toHaveCount(2);
    await expect(seat(host, "Bo")).toBeVisible();

    await hostContext.close();
    await guestContext.close();
  });
});
