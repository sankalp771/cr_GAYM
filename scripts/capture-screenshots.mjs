/**
 * Regenerate the README screenshots.
 *
 *   npm run build
 *   npx next start --port 3200 &
 *   node scripts/capture-screenshots.mjs
 *
 * Plays a scripted opening so the board has colour on both sides and a real
 * cascade behind it, rather than photographing an empty grid.
 */
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const BASE = process.env.SHOT_BASE ?? "http://127.0.0.1:3200";
const OUT = "docs/images";

// Alternating moves that build pressure in the middle for both players.
const OPENING = [
  [2, 2], [3, 3],
  [2, 3], [3, 2],
  [1, 2], [4, 3],
  [2, 2], [3, 3],
  [2, 3], [3, 2],
  [1, 1], [4, 4],
  [2, 2], [3, 3]
];

const cellAt = (page, row, col) =>
  page.getByRole("button", { name: new RegExp(`^Row ${row + 1}, column ${col + 1}:`) });

async function playOpening(page, moves) {
  for (const [row, col] of moves) {
    const target = cellAt(page, row, col);
    if (await target.isEnabled().catch(() => false)) {
      await target.click();
      await page.waitForTimeout(420);
    }
  }
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();

const desktop = await browser.newPage({ viewport: { width: 1440, height: 950 } });
await desktop.goto(`${BASE}/`, { waitUntil: "networkidle" });
await desktop.waitForTimeout(1200);
await desktop.screenshot({ path: `${OUT}/home.png` });

await desktop.goto(`${BASE}/local`, { waitUntil: "networkidle" });
await desktop.getByRole("button", { name: "Start Battle" }).first().click();
await desktop.waitForTimeout(600);
await playOpening(desktop, OPENING);
await desktop.waitForTimeout(900);
await desktop.screenshot({ path: `${OUT}/local-arena.png` });

// 1x device scale deliberately: these land in git and are regenerated whenever
// the UI moves, so every retina copy would be kept in history forever.
const mobile = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true
});
await mobile.goto(`${BASE}/local`, { waitUntil: "networkidle" });
await mobile.getByRole("button", { name: "Start Battle" }).first().click();
await mobile.waitForTimeout(800);
await playOpening(mobile, OPENING.slice(0, 8));
await mobile.waitForTimeout(700);
await mobile.screenshot({ path: `${OUT}/local-mobile.png` });

await browser.close();
console.log(`Captured into ${OUT}/`);
