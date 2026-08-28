import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // Build output + packaged artifacts, never authored here.
    ignores: [
      "node_modules/**",
      "release/**",
      "dist/**",
      "out/**",
      "**/*.min.js",
    ],
  },
  js.configs.recommended,
  {
    // ESM files (this config included) — .mjs is always a module.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
  {
    // Electron MAIN process + shared modules + build scripts: plain Node.
    files: ["src/main/**/*.js", "src/shared/**/*.js", "scripts/**/*.js", "*.js", "*.cjs"],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 2022,
      sourceType: "commonjs",
    },
    rules: {
      "no-use-before-define": ["error", { functions: false, classes: true, variables: true }],
      "no-undef": "error",
      "no-shadow": "warn",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-async-promise-executor": "error",
      "no-await-in-loop": "warn",
      "no-cond-assign": "error",
    },
  },
  {
    // Cloudflare Worker (the lyrics mirror). Not Node and not a browser: an ESM
    // module against the Workers runtime, whose globals are the service-worker
    // set (fetch/Request/Response/caches) rather than either of those.
    files: ["services/**/src/**/*.js"],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser },
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-cond-assign": "error",
    },
  },
  {
    // Preload scripts straddle both worlds: Node require() plus the page's
    // window/document. Electron exposes both in the isolated preload realm.
    files: ["src/preload/**/*.js"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      ecmaVersion: 2022,
      sourceType: "commonjs",
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-cond-assign": "error",
    },
  },
];
