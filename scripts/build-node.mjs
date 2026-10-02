// Bundles a backend app (run from the app's directory) into dist/index.js.
// Workspace packages export TypeScript source, so they are bundled in; third-party
// dependencies stay external and are loaded from node_modules at runtime.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !name.startsWith("@ai-pr-review/"),
);

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/index.js",
  sourcemap: true,
  external,
  logLevel: "info",
});
