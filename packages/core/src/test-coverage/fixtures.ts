import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Real tool output kept in `__fixtures__`: `jest.lcov` (Jest 30, istanbul) and `vitest-v8.lcov` (Vitest 5, v8). */
export const fixture = (name: string): string =>
  readFileSync(join(__dirname, "__fixtures__", name), "utf8");
