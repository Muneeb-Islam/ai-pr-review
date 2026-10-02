import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-console": "error",
    },
  },
  // Tenant isolation (design §9): only packages/db may touch raw tables, and only the api and worker
  // may use the unscoped "system" module. Everything else goes through the tenant-scoped functions.
  {
    files: ["apps/**/*.{ts,tsx}", "packages/core/**/*.ts", "packages/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@ai-pr-review/db/schema",
              message:
                "Raw tables bypass tenant scoping. Use the tenant-scoped functions of @ai-pr-review/db.",
            },
            {
              name: "drizzle-orm",
              message: "Queries belong in packages/db, behind tenant-scoped functions.",
            },
          ],
          patterns: [
            {
              group: ["drizzle-orm/*"],
              message: "Queries belong in packages/db, behind tenant-scoped functions.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}", "packages/core/**/*.ts", "packages/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@ai-pr-review/db",
              message: "The dashboard, core and shared code never access the database.",
            },
            {
              name: "@ai-pr-review/db/system",
              message: "Unscoped queries are for the api (webhooks) and worker only.",
            },
            { name: "@ai-pr-review/db/schema", message: "Raw tables bypass tenant scoping." },
            { name: "drizzle-orm", message: "Queries belong in packages/db." },
          ],
          patterns: [{ group: ["drizzle-orm/*"], message: "Queries belong in packages/db." }],
        },
      ],
    },
  },
  {
    files: ["**/scripts/**"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", setTimeout: "readonly" },
    },
    rules: { "no-console": "off" },
  },
);
