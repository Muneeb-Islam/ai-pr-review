import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` only diffs src/schema.ts against ./migrations; it never connects to a database.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
