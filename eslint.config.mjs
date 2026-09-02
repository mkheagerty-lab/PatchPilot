import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

/**
 * One flat config for the whole pnpm workspace (apps/* and packages/*) —
 * every package's "lint" script just runs `eslint .` from its own directory
 * and ESLint's flat-config resolution walks up to find this file. Kept to
 * type-check-free rules (no tsconfig `project` wiring) so lint stays fast and
 * doesn't require a parserOptions.project entry per package.
 */
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "**/drizzle/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Codebase leans on `any` deliberately in a few narrow spots (dynamic
      // tool/plugin registries, third-party shapes) — off rather than a
      // blanket warning nobody will action.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Locale-handling regexes intentionally use CJK/other Unicode space
      // characters as literal range boundaries (e.g. hasNonLatinScript in
      // packages/shared/src/winget.ts) — not a stray-whitespace bug.
      "no-irregular-whitespace": ["error", { skipRegExps: true }],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // Only the two long-stable hooks rules — v7's "recommended" bundle also
      // pulls in the React Compiler readiness rules (purity, set-state-in-effect,
      // preserve-manual-memoization, etc.), which flag long-standing, correct
      // patterns already throughout this codebase (e.g. pruning stale selection
      // state from an effect) as errors. This codebase doesn't target the
      // Compiler, so those rules are noise here, not signal.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": "warn",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
