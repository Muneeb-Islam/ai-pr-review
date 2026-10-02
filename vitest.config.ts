import { defineConfig } from "vitest/config";

// One shared config. Workspace packages export their TypeScript source, so no build is needed to test.
export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
