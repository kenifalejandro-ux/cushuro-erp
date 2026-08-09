import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import globals from "globals";

// Archivos que tsconfig.json compila (root files + lo que importan
// transitivamente): acá sí tenemos type info, así que agregamos reglas
// type-aware. Todo lo demás en el repo (eslint.config.js, playwright.config.ts,
// vitest.config.mts, e2e/**) queda fuera de ese programa de TypeScript y
// solo recibe las reglas sintácticas de abajo -- pedirles projectService
// tiraría "file not found by project service".
const typeCheckedFiles = [
  "server.ts",
  "migrate.ts",
  "src/server/**/*.ts",
  "src/modules/**/*.ts",
  "scripts/**/*.ts",
  "tests/**/*.ts",
];

export default defineConfig([
  globalIgnores(["coverage", "test-results", "backups", "migrations", "client"]),
  {
    // Reglas base para todo archivo .ts del backend, tenga o no type info.
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tsPlugin.configs["flat/recommended"], eslintConfigPrettier],
    plugins: {
      prettier: prettierPlugin,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      globals: globals.node,
    },
    rules: {
      // TypeScript ya detecta identificadores no definidos con más
      // precisión que la regla base de eslint (que no entiende tipos).
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^[A-Z_]", argsIgnorePattern: "^_" },
      ],
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
      "prettier/prettier": "error",
    },
  },
  {
    // scripts/, tests/ y migrate.ts son código de operación/CLI, no rutas
    // HTTP: ahí console.log() es el output esperado, no un rezago de debug
    // -- a diferencia de src/**, que ya usa pino y donde un console.log
    // suelto sí es señal de un olvido.
    files: ["scripts/**/*.ts", "tests/**/*.ts", "migrate.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // any en tests/ es mocks/stubs y respuestas parciales de fixtures --
    // tipar cada uno con precisión no atrapa bugs de producción (a
    // diferencia de src/**, donde si se corrigieron los 34 casos previos a
    // este commit). No se relaja en scripts/ (ahí sí corre contra la BD
    // real).
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: typeCheckedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Curado a propósito en vez de sumar todo "recommended-type-checked":
      // reglas como no-unsafe-* generan cientos de falsos positivos sobre
      // filas de pg y bodies de Express sin tipar en runtime, sin atrapar
      // bugs reales. Estas tres sí son señal de bugs concretos de async.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    files: ["eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
]);
