import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildConfigJsonSchema } from "./jsonSchema";

describe("config JSON Schema file", () => {
  it("schemas/ai-pr-review.schema.json is up to date (run `npm run schema`)", () => {
    const onDisk = readFileSync(
      new URL("../../schemas/ai-pr-review.schema.json", import.meta.url),
      "utf8",
    );
    expect(JSON.parse(onDisk)).toEqual(JSON.parse(JSON.stringify(buildConfigJsonSchema())));
  });

  it("forbids unknown keys and leaves out the dashboard-only keys", () => {
    const schema = buildConfigJsonSchema() as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
    for (const key of ["provider", "model", "base_url", "limits"]) {
      expect(schema.properties).not.toHaveProperty(key);
    }
    expect(schema.properties).toHaveProperty("review");
    expect(schema.properties).toHaveProperty("fork_prs");
  });
});
