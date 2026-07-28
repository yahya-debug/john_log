import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

// typescript-eslint refuses to load against TypeScript 7.x (see
// https://github.com/typescript-eslint/typescript-eslint/issues/10940), so
// TS files aren't linted here. `npm run typecheck` (tsc --noEmit, strict)
// is the real type-correctness gate; this config covers plain JS/config files.
export default defineConfig([
  { files: ["**/*.{js,mjs,cjs}"], plugins: { js }, extends: ["js/recommended"], languageOptions: { globals: { ...globals.node } } },
]);
