import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "./client";
import { endpoints } from "./contract";
import { OPENAPI_INFO } from "./info";
import { buildOpenApiDocument } from "./openapi";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const me = {
  user: { id: "u1", login: "octocat", avatar_url: null },
  csrf_token: "tok-1",
  installations: [],
  install_url: "https://github.com/apps/x/installations/new",
};

describe("OpenAPI document", () => {
  const doc = buildOpenApiDocument(OPENAPI_INFO) as {
    paths: Record<string, Record<string, { operationId: string; security?: unknown[] }>>;
    components: { schemas: Record<string, unknown> };
  };

  it("describes every endpoint of the contract", () => {
    const ids = Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods).map((op) => op.operationId),
    );
    expect(ids.sort()).toEqual(Object.keys(endpoints).sort());
    expect(doc.paths["/api/repos/{id}/settings"]).toBeDefined();
  });

  it("requires the CSRF header only on mutating session endpoints", () => {
    expect(doc.paths["/api/me"]!["get"]!.security).toEqual([{ cookieAuth: [] }]);
    expect(doc.paths["/api/repos/{id}/credentials"]!["put"]!.security).toEqual([
      { cookieAuth: [], csrfToken: [] },
    ]);
    expect(doc.paths["/auth/github/login"]!["get"]!.security).toBeUndefined();
  });

  it("matches the committed schemas/openapi.json (run `npm run schema` after changing the contract)", () => {
    const committed = readFileSync(new URL("../../schemas/openapi.json", import.meta.url), "utf8");
    expect(JSON.parse(committed)).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it("never describes a field that could carry a stored provider key in a response", () => {
    const responses = JSON.stringify(
      Object.values(doc.paths).flatMap((m) =>
        Object.values(m).map((op) => (op as never)["responses"]),
      ),
    );
    expect(responses).not.toMatch(/ciphertext|api_key|key_version/);
  });
});

describe("api client", () => {
  it("fetches the CSRF token before the first mutation and sends it", async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const client = createApiClient({
      baseUrl: "http://api.test/",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: String(init?.method),
          headers: init?.headers as Record<string, string>,
          ...(init?.body ? { body: String(init.body) } : {}),
        });
        return String(url).endsWith("/api/me") ? json(me) : json({ ok: true });
      },
    });
    const result = await client.call("deleteRepoCredential", {
      params: { id: "a/b" },
      query: { provider: "deepseek" },
    });
    expect(result).toEqual({ ok: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET http://api.test/api/me",
      "DELETE http://api.test/api/repos/a%2Fb/credentials?provider=deepseek",
    ]);
    expect(calls[1]!.headers["x-csrf-token"]).toBe("tok-1");
  });

  it("sends JSON bodies and asks again once when the token is rejected", async () => {
    let token = 0;
    let puts = 0;
    const client = createApiClient({
      fetch: async (url, init) => {
        if (String(url) === "/api/me") return json({ ...me, csrf_token: `tok-${++token}` });
        puts++;
        const sent = (init?.headers as Record<string, string>)["x-csrf-token"];
        if (sent === "tok-1") {
          return json({ error: { code: "csrf_invalid", message: "bad token" } }, 403);
        }
        return json({
          credential: {
            id: "c1",
            provider: "deepseek",
            scope: "repository",
            last4: "wxyz",
            created_at: "2026-10-02T10:00:00.000Z",
          },
        });
      },
    });
    const result = await client.call("putRepoCredential", {
      params: { id: "r1" },
      body: { provider: "deepseek", api_key: "sk-0123456789" },
    });
    expect(result.credential.last4).toBe("wxyz");
    expect(puts).toBe(2);
  });

  it("turns the error envelope into an ApiError", async () => {
    const client = createApiClient({
      fetch: async () =>
        json(
          {
            error: { code: "not_found", message: "Not found", request_id: "req-9", details: ["x"] },
          },
          404,
        ),
    });
    const error = await client.call("getRepo", { params: { id: "nope" } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      code: "not_found",
      requestId: "req-9",
      details: ["x"],
    });
  });

  it("builds the sign-in URL for a navigation", () => {
    const client = createApiClient({ baseUrl: "http://api.test" });
    expect(client.loginUrl("/repos?x=1")).toBe(
      "http://api.test/auth/github/login?return_to=%2Frepos%3Fx%3D1",
    );
  });
});
