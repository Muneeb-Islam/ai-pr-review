import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Reads a file of apps/web as text, whether the tests run from the repository root or from apps/web. */
export function readWebFile(relative: string): string {
  for (const base of [resolve(process.cwd(), "apps/web"), process.cwd()]) {
    const file = resolve(base, relative);
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  throw new Error(`Cannot find ${relative} from ${process.cwd()}`);
}
