// Helpers that translate the neutral `jsonSchema` of a request for APIs with different structured-output
// support. JSON Schema here is the plain object a caller passes; nothing is validated (Phase 7 validates).

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * True when the schema satisfies OpenAI's strict structured-output rules: every object lists all its
 * properties as required and forbids additional ones. Anything else must be sent with `strict: false`,
 * or the API rejects the request.
 */
export function isStrictCompatible(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(isStrictCompatible);
  if (!isObject(schema)) return true;
  if (schema["type"] === "object" || isObject(schema["properties"])) {
    const properties = isObject(schema["properties"]) ? Object.keys(schema["properties"]) : [];
    const required = Array.isArray(schema["required"]) ? schema["required"] : [];
    if (schema["additionalProperties"] !== false) return false;
    if (!properties.every((key) => required.includes(key))) return false;
  }
  return Object.values(schema).every(isStrictCompatible);
}

/** A small example value for a schema, for APIs that only offer "JSON mode" and want the shape described. */
export function schemaExample(schema: unknown, depth = 0): unknown {
  if (!isObject(schema) || depth > 6) return null;
  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) return schema["enum"][0];
  if ("const" in schema) return schema["const"];
  for (const key of ["anyOf", "oneOf"]) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0) return schemaExample(options[0], depth + 1);
  }
  const type = Array.isArray(schema["type"]) ? schema["type"][0] : schema["type"];
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    case "array":
      return "items" in schema ? [schemaExample(schema["items"], depth + 1)] : [];
    default: {
      if (!isObject(schema["properties"])) return {};
      return Object.fromEntries(
        Object.entries(schema["properties"]).map(([key, value]) => [
          key,
          schemaExample(value, depth + 1),
        ]),
      );
    }
  }
}

/**
 * System prompt for JSON-mode APIs without schema enforcement (DeepSeek): the schema and an example are
 * described in the prompt, and the word "json" appears as the API requires.
 */
export function describeJsonSchema(system: string, schema: object): string {
  return [
    system,
    "",
    "Respond with a single json object and nothing else: no prose, no code fences.",
    "It must conform to this JSON Schema:",
    JSON.stringify(schema),
    "Example of the shape (values are placeholders):",
    JSON.stringify(schemaExample(schema)),
  ].join("\n");
}
