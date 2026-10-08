import { writeFileSync } from "node:fs";
import { buildOpenApiDocument } from "../src/api/openapi";
import { OPENAPI_INFO } from "../src/api/info";

writeFileSync(
  new URL("../schemas/openapi.json", import.meta.url),
  `${JSON.stringify(buildOpenApiDocument(OPENAPI_INFO), null, 2)}\n`,
);
console.log("Wrote packages/shared/schemas/openapi.json");
