// Bundles a backend entry point (run from the app's directory) into one file.
//   node ../../scripts/build-node.mjs                       src/index.ts -> dist/index.js
//   node ../../scripts/build-node.mjs scripts/x.ts dist/x.js
// Workspace packages export TypeScript source, so they are bundled in; third-party
// dependencies stay external and are loaded from node_modules at runtime.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const [entry = "src/index.ts", outfile = "dist/index.js"] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !name.startsWith("@ai-pr-review/"),
);

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile,
  sourcemap: true,
  external,
  // Some bundled dependencies (yaml) are CommonJS and `require` Node's own modules; an ES module has no `require`.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: "info",
});
