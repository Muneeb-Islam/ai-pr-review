// OpenAPI 3.1 document generated from the endpoint table and its zod schemas (no hand-written spec to drift).
import { z } from "zod";
import { endpoints, isMutation, type EndpointDef } from "./contract";
import { errorResponseSchema } from "./schemas";

type JsonSchema = Record<string, unknown>;

const toSchema = (schema: z.ZodType, io: "input" | "output"): JsonSchema => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    unrepresentable: "any",
  }) as JsonSchema;
  return rest;
};

/** `/api/repos/:id` becomes `/api/repos/{id}`. */
const openApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

function parametersOf(schema: z.ZodObject | undefined, where: "path" | "query") {
  if (!schema) return [];
  const json = toSchema(schema, "input");
  const properties = (json["properties"] ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json["required"] ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: where,
    required: where === "path" ? true : required.has(name),
    schema: property,
  }));
}

function operation(name: string, def: EndpointDef) {
  const status = def.status ?? 200;
  const errorRef = { $ref: "#/components/schemas/Error" };
  const errorContent = { "application/json": { schema: errorRef } };
  const responses: Record<string, unknown> = {};

  if (def.stream === "sse") {
    responses["200"] = {
      description: "Event stream",
      content: { "text/event-stream": { schema: { type: "string" } } },
    };
  } else if (def.download === "csv") {
    responses["200"] = {
      description: "A CSV file",
      headers: { "Content-Disposition": { schema: { type: "string" } } },
      content: { "text/csv": { schema: { type: "string" } } },
    };
  } else if (status === 302) {
    responses["302"] = {
      description: "Redirect",
      headers: { Location: { schema: { type: "string" } } },
    };
  } else {
    responses[String(status)] = {
      description: "Success",
      content: { "application/json": { schema: toSchema(def.response, "output") } },
    };
  }
  responses["400"] = { description: "Invalid input", content: errorContent };
  if (def.auth === "session") {
    responses["401"] = { description: "Not signed in", content: errorContent };
    // Cross-tenant access is indistinguishable from a missing resource on purpose.
    responses["404"] = { description: "Not found (or not accessible)", content: errorContent };
    if (def.role === "admin") {
      responses["403"] = {
        description: "Signed in and able to see the resource, but not an admin",
        content: errorContent,
      };
    }
  }
  responses["429"] = { description: "Rate limited", content: errorContent };

  return {
    operationId: name,
    summary: def.summary,
    ...(def.description ? { description: def.description } : {}),
    tags: [def.tag],
    ...(def.auth === "session"
      ? {
          security: [
            isMutation(def.method) ? { cookieAuth: [], csrfToken: [] } : { cookieAuth: [] },
          ],
        }
      : {}),
    parameters: [...parametersOf(def.params, "path"), ...parametersOf(def.query, "query")],
    ...(def.body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: toSchema(def.body, "input") } },
          },
        }
      : {}),
    responses,
  };
}

export function buildOpenApiDocument(info: { title: string; version: string }): object {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [name, def] of Object.entries(endpoints) as Array<[string, EndpointDef]>) {
    const path = openApiPath(def.path);
    paths[path] ??= {};
    paths[path][def.method.toLowerCase()] = operation(name, def);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: info.title,
      version: info.version,
      description:
        "Dashboard API. Authenticate with the session cookie set by /auth/github/login. Mutating requests also " +
        "need the X-CSRF-Token header (the value is in the response of GET /api/me). Errors use a common envelope.",
    },
    paths,
    components: {
      schemas: { Error: toSchema(errorResponseSchema, "output") },
      securitySchemes: {
        cookieAuth: { type: "apiKey", in: "cookie", name: "aipr_session" },
        csrfToken: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
      },
    },
  };
}
