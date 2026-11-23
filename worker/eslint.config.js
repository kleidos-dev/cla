// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
//
// The Kleidos quality kit's TypeScript base (strictTypeChecked, no-deprecated,
// switch-exhaustiveness-check: .github/quality/eslint.base.mjs, a copy) over
// the Worker, its tests and its config, plus ESLint's recommended rules over
// the plain JavaScript helpers. A kit rule turned off or down here needs a
// waiver in .github/quality/waivers.toml.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { kleidosTypeScript } from "../.github/quality/eslint.base.mjs";

export default [
  { ignores: ["node_modules/**", ".wrangler/**", "dist/**", "coverage/**"] },
  ...kleidosTypeScript({ js, tseslint, tsconfigRootDir: import.meta.dirname }),
  {
    files: ["**/*.ts"],
    rules: {
      // Numbers read the same in a template as through String(); every other
      // type (nullish, objects, booleans) still has to be converted on purpose.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    ...js.configs.recommended,
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
];
