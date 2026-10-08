// `npm run acceptance:doc`: writes docs/acceptance.md from acceptance/traceability.ts.
import { writeFileSync } from "node:fs";
import { renderTraceability } from "../acceptance/traceability";

writeFileSync(new URL("../docs/acceptance.md", import.meta.url), renderTraceability());
process.stdout.write("docs/acceptance.md written.\n");
