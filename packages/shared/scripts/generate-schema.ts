import { writeFileSync } from "node:fs";
import { buildConfigJsonSchema } from "../src/config/jsonSchema";

writeFileSync(
  new URL("../schemas/ai-pr-review.schema.json", import.meta.url),
  `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`,
);
console.log("Wrote packages/shared/schemas/ai-pr-review.schema.json");
