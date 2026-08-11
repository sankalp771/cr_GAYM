import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
      // Wrangler's bundler scratch space. Generated code, not ours to lint.
      ".wrangler/**"
    ]
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // The game engine is the one place where purity is a hard rule rather than a
    // preference, so the lint config enforces it instead of relying on review.
    // See CLAUDE.md — no React, no DOM, no non-determinism inside lib/engine/.
    files: ["lib/engine/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "window", message: "lib/engine must stay pure — no DOM access." },
        { name: "document", message: "lib/engine must stay pure — no DOM access." },
        { name: "localStorage", message: "lib/engine must stay pure — no persistence." }
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "lib/engine must stay deterministic — pass timestamps in." },
        { object: "Math", property: "random", message: "lib/engine must stay deterministic — pass a seeded rng in." }
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["react", "react-dom", "next/*", "motion/*", "@/components/*"], message: "lib/engine must stay framework-free." }
          ]
        }
      ]
    }
  }
];

export default config;
