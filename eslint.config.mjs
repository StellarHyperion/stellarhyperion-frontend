import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

/**
 * Flat config, taking `eslint-config-next`'s own arrays directly.
 *
 * Next 16 ships these as real flat configs, so there is no FlatCompat shim here. On top of them
 * sit typescript-eslint's type checked presets, which need a real program and are the reason
 * `projectService` is on: the rules worth having, like no-floating-promises and the exhaustive
 * switch check, cannot work from syntax alone.
 */
export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    rules: {
      // The protocol package speaks bigint, and a template literal is the readable way to print
      // one. allowNumber covers bigint in this version of the rule; without it every amount would
      // be wrapped in String() for no benefit.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unnecessary-condition": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
