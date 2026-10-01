import { writeFileSync } from "node:fs";
import { buildConfigJsonSchema } from "../src/config/jsonSchema";

writeFileSync(
  "schemas/ai-pr-review.schema.json",
  `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`,
);
console.log("Wrote schemas/ai-pr-review.schema.json");
