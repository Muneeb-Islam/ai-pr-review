import { defineConfig } from "vitest/config";

// Chaos checks (Phase 15): real worker processes against real PostgreSQL and Redis containers that the suite starts, stops
// and destroys. Needs Docker, takes a few minutes, so it is not part of `npm test`: `npm run test:chaos`.
export default defineConfig({
  test: {
    name: "chaos",
    environment: "node",
    include: ["apps/worker/chaos/**/*.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // One scenario at a time: they take whole containers down.
    fileParallelism: false,
  },
});
