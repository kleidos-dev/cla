// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
//
// The Kleidos quality kit's ESLint base (kleidos-dev/.github
// quality/eslint/base.mjs), copied to .github/quality/eslint.base.mjs.
//
// A factory that imports nothing, so it works wherever the repository keeps
// its node_modules: the repository passes in its own @eslint/js and
// typescript-eslint (ESLint 9 or newer, typescript-eslint 8 or newer):
//
//   import js from "@eslint/js";
//   import tseslint from "typescript-eslint";
//   import { kleidosTypeScript } from "../.github/quality/eslint.base.mjs";
//
//   export default [
//     ...kleidosTypeScript({ js, tseslint, tsconfigRootDir: import.meta.dirname }),
//     // local additions here; a rule turned "off" or "warn" needs a waiver
//   ];

/**
 * The kit's flat config for TypeScript sources.
 *
 * @param {{ js: any, tseslint: any, tsconfigRootDir: string, files?: string[] }} deps
 * @returns {any[]} flat config objects
 */
export function kleidosTypeScript({ js, tseslint, tsconfigRootDir, files = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"] }) {
  const typed = tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files }));
  return [
    { ...js.configs.recommended, files },
    ...typed,
    {
      files,
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        "@typescript-eslint/no-deprecated": "error",
        "@typescript-eslint/switch-exhaustiveness-check": "error",
      },
    },
  ];
}
