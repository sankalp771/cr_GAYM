import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": rootDir }
  },
  test: {
    // Two projects rather than one jsdom default: the engine suite runs in plain
    // Node so that an accidental DOM dependency in lib/engine/ fails the tests
    // rather than silently passing against a jsdom global.
    projects: [
      {
        resolve: { alias: { "@": rootDir } },
        test: {
          name: "engine",
          environment: "node",
          include: ["lib/**/*.test.ts"],
          // A cascade bug used to hang forever. The engine now has its own
          // internal pass ceiling, but this is the outer backstop so a
          // regression fails CI instead of blocking it.
          testTimeout: 10_000
        }
      },
      {
        plugins: [react()],
        resolve: { alias: { "@": rootDir } },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["{app,components}/**/*.test.{ts,tsx}"],
          setupFiles: ["./vitest.setup.ts"],
          testTimeout: 10_000
        }
      }
    ]
  }
});
