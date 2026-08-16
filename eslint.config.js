import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

// typescript-eslint refuses to load against TypeScript 7.x (see
// https://github.com/typescript-eslint/typescript-eslint/issues/10940), so
// TS files aren't linted here. `npm run typecheck` (tsc --noEmit, strict)
// is the real type-correctness gate; this config covers plain JS/config files.
export default defineConfig([
  { files: ["**/*.{js,mjs,cjs}"], ignores: ["loadtest/k6/**"], plugins: { js }, extends: ["js/recommended"], languageOptions: { globals: { ...globals.node } } },
  // k6 scripts run in k6's own JS runtime (goja), not Node — __ENV/__VU/__ITER
  // are k6 globals (https://k6.io/docs/using-k6/k6-options/environment-variables/),
  // and `k6`/`k6/http`/`k6/metrics` are virtual modules only k6's loader resolves,
  // so this block skips no-undef/import-resolution assumptions Node wouldn't share.
  { files: ["loadtest/k6/**/*.js"], plugins: { js }, extends: ["js/recommended"], languageOptions: { globals: { __ENV: "readonly", __VU: "readonly", __ITER: "readonly", console: "readonly" } } },
]);
