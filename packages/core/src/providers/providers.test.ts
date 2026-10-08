import { readdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo, type LookupFunction } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "@ai-pr-review/shared";
import {
  createHttpsTransport,
  createMockProvider,
  createProvider,
  DEFAULT_BASE_URLS,
  isStrictCompatible,
  ProviderAuthError,
  ProviderBudgetExceeded,
  ProviderCancelled,
  ProviderInvalidResponse,
  ProviderRateLimit,
  ProviderTimeout,
  ProviderUnavailable,
  RunGovernor,
  schemaExample,
  testConnection,
  TransportError,
  type HttpRequest,
  type HttpResponse,
  type Provider,
  type ProviderRequest,
  type Transport,
} from "..";

const KEY = "sk-canary-0123456789abcdef0123456789abcdef";
const SCHEMA = {
  type: "object",
  properties: {
    findings: { type: "array", items: { type: "string" } },
    verdict: { enum: ["ok", "bad"] },
  },
  required: ["findings", "verdict"],
  additionalProperties: false,
};
const ANSWER = { findings: ["a"], verdict: "ok" };

const request = (extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: "You review code.",
  user: "SECRET-PROMPT-TEXT diff here",
  jsonSchema: SCHEMA,
  maxOutputTokens: 1000,
  timeoutMs: 5000,
  ...extra,
});

type Step = Partial<HttpResponse> | Error | ((req: HttpRequest) => Promise<HttpResponse>);

/** A transport that plays the steps in order (the last repeats) and records what it was sent. */
function script(...steps: Step[]) {
  const calls: HttpRequest[] = [];
  const transport: Transport = async (req) => {
    const step = steps[Math.min(calls.length, steps.length - 1)]!;
    calls.push(req);
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(req);
    return { status: 200, headers: {}, body: "", ...step };
  };
  return { transport, calls };
}

const openaiBody = (content: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
    ...extra,
  });
const ok = (content: unknown = ANSWER): Step => ({ body: openaiBody(JSON.stringify(content)) });

const sleeps: number[] = [];
const retry = {
  sleep: async (ms: number) => void sleeps.push(ms),
  random: () => 0.5,
  baseDelayMs: 100,
  maxDelayMs: 1000,
};

function deepseek(transport: Transport, extra: Record<string, unknown> = {}) {
  sleeps.length = 0;
  return createProvider({
    name: "deepseek",
    model: "deepseek-flash",
    apiKey: KEY,
    transport,
    retry,
    ...extra,
  });
}

describe("DeepSeek adapter", () => {
  it("sends an OpenAI-compatible JSON-mode request and returns parsed JSON with usage", async () => {
    const { transport, calls } = script(ok());
    const result = await deepseek(transport).complete(request());

    expect(result).toEqual({
      json: ANSWER,
      usage: { inputTokens: 120, outputTokens: 30 },
      model: "deepseek-flash",
      retries: 0,
    });
    const call = calls[0]!;
    expect(call.url.toString()).toBe("https://api.deepseek.com/chat/completions");
    expect(call.headers["authorization"]).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({
      model: "deepseek-flash",
      response_format: { type: "json_object" },
      max_tokens: 1000,
      temperature: 0,
      stream: false,
    });
    // JSON mode needs the word "json" and an example; the schema travels in the prompt.
    expect(body.messages[0].content).toMatch(/json/i);
    expect(body.messages[0].content).toContain('"verdict"');
    expect(body.messages[0].content).toContain('{"findings":["string"],"verdict":"ok"}');
    expect(body.messages[1]).toEqual({ role: "user", content: request().user });
  });

  it("accepts JSON wrapped in a code fence", async () => {
    const { transport } = script({
      body: openaiBody("```json\n" + JSON.stringify(ANSWER) + "\n```"),
    });
    expect((await deepseek(transport).complete(request())).json).toEqual(ANSWER);
  });

  it("estimates usage when the provider reports none", async () => {
    const { transport } = script({
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(ANSWER) } }] }),
    });
    const { usage } = await deepseek(transport).complete(request());
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it("fails on malformed JSON without retrying", async () => {
    const { transport, calls } = script({ body: openaiBody("{not json") });
    await expect(deepseek(transport).complete(request())).rejects.toBeInstanceOf(
      ProviderInvalidResponse,
    );
    expect(calls).toHaveLength(1);
  });

  it("fails on a non-JSON HTTP body and on a reply cut off at the token limit", async () => {
    await expect(
      deepseek(script({ body: "<html>" }).transport).complete(request()),
    ).rejects.toBeInstanceOf(ProviderInvalidResponse);
    const cut = script({
      body: openaiBody("{", { choices: [{ finish_reason: "length", message: { content: "{" } }] }),
    });
    await expect(deepseek(cut.transport).complete(request())).rejects.toThrow(/cut off/);
  });

  it("retries the empty reply DeepSeek sometimes returns", async () => {
    const { transport, calls } = script({ body: openaiBody("") }, ok());
    const result = await deepseek(transport).complete(request());
    expect(result.json).toEqual(ANSWER);
    expect(result.retries).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("times out, retries once, then reports ProviderTimeout", async () => {
    const { transport, calls } = script(new TransportError("timeout"));
    const err = await deepseek(transport)
      .complete(request())
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderTimeout);
    expect(calls).toHaveLength(2);
  });

  it("honours Retry-After on 429 and then succeeds", async () => {
    const { transport, calls } = script({ status: 429, headers: { "retry-after": "2" } }, ok());
    const result = await deepseek(transport).complete(request());
    expect(result.retries).toBe(1);
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it("does not wait for a Retry-After beyond the limit", async () => {
    const { transport, calls } = script({ status: 429, headers: { "retry-after": "600" } });
    const err = await deepseek(transport)
      .complete(request())
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRateLimit);
    expect(err.retryAfterMs).toBe(600_000);
    expect(calls).toHaveLength(1);
  });

  it("backs off exponentially on 5xx and succeeds on the next try", async () => {
    const { transport } = script({ status: 503 }, { status: 502 }, ok());
    const result = await deepseek(transport).complete(request());
    expect(result.retries).toBe(2);
    // Equal jitter with random()=0.5: 0.75 x the capped backoff of 100 ms, then 200 ms.
    expect(sleeps).toEqual([75, 150]);
  });

  it("gives up after the retries and keeps the retry count on the error", async () => {
    const { transport, calls } = script({ status: 500 });
    const err = await deepseek(transport)
      .complete(request())
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailable);
    expect(err.status).toBe(500);
    expect(err.retries).toBe(2);
    expect(calls).toHaveLength(3);
  });

  it("treats a network failure as unavailable and retries it", async () => {
    const { transport, calls } = script(new TransportError("network"), ok());
    expect((await deepseek(transport).complete(request())).retries).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it.each([401, 403])("does not retry HTTP %i", async (status) => {
    const { transport, calls } = script({ status });
    await expect(deepseek(transport).complete(request())).rejects.toBeInstanceOf(ProviderAuthError);
    expect(calls).toHaveLength(1);
  });

  it("does not retry HTTP 400", async () => {
    const { transport, calls } = script({ status: 400, body: "{}" });
    const err = await deepseek(transport)
      .complete(request())
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderInvalidResponse);
    expect(err.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("can leave the temperature out", async () => {
    const { transport, calls } = script(ok());
    await deepseek(transport, { temperature: null }).complete(request());
    expect(JSON.parse(calls[0]!.body)).not.toHaveProperty("temperature");
  });
});

describe("OpenAI adapter", () => {
  const openai = (transport: Transport, extra: Record<string, unknown> = {}) =>
    createProvider({ name: "openai", model: "gpt-4.1", apiKey: KEY, transport, retry, ...extra });

  it("uses structured outputs with strict mode when the schema allows it", async () => {
    const { transport, calls } = script(ok());
    await openai(transport).complete(request());
    expect(calls[0]!.url.toString()).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(calls[0]!.body);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "response", schema: SCHEMA, strict: true },
    });
    expect(body.max_completion_tokens).toBe(1000);
    expect(body.temperature).toBe(0);
    expect(body.messages[0].content).toBe("You review code.");
  });

  it("sends a schema with optional properties unenforced instead of failing the request", async () => {
    const loose = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    const { transport, calls } = script(ok());
    await openai(transport).complete(request({ jsonSchema: loose }));
    expect(JSON.parse(calls[0]!.body).response_format.json_schema.strict).toBe(false);
  });

  it("omits the temperature for reasoning models", async () => {
    const { transport, calls } = script(ok());
    await openai(transport, { model: "gpt-5" }).complete(request());
    expect(JSON.parse(calls[0]!.body)).not.toHaveProperty("temperature");
  });

  it("falls back to JSON mode on a custom OpenAI-compatible endpoint", async () => {
    const { transport, calls } = script(ok());
    const provider = openai(transport, {
      baseUrl: "https://llm.example.com/v1/",
      validateUrl: async (raw: string) => ({ ok: true as const, url: new URL(raw) }),
    });
    await provider.complete(request());
    expect(calls[0]!.url.toString()).toBe("https://llm.example.com/v1/chat/completions");
    const body = JSON.parse(calls[0]!.body);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(1000);
    expect(body.messages[0].content).toMatch(/JSON Schema/);
  });

  it("treats a refusal as an invalid response", async () => {
    const { transport } = script({
      body: JSON.stringify({ choices: [{ message: { content: null, refusal: "no" } }] }),
    });
    await expect(openai(transport).complete(request())).rejects.toThrow(/declined/);
  });
});

describe("Anthropic adapter", () => {
  const anthropic = (transport: Transport, extra: Record<string, unknown> = {}) =>
    createProvider({
      name: "anthropic",
      model: "claude-sonnet-5-5",
      apiKey: KEY,
      transport,
      retry,
      ...extra,
    });
  const reply = (extra: Record<string, unknown> = {}): Step => ({
    body: JSON.stringify({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", name: "report", input: ANSWER },
      ],
      usage: { input_tokens: 200, output_tokens: 40 },
      ...extra,
    }),
  });

  it("forces one tool call whose input schema is the answer schema", async () => {
    const { transport, calls } = script(reply());
    const result = await anthropic(transport).complete(request());
    expect(result).toEqual({
      json: ANSWER,
      usage: { inputTokens: 200, outputTokens: 40 },
      model: "claude-sonnet-5-5",
      retries: 0,
    });
    const call = calls[0]!;
    expect(call.url.toString()).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe(KEY);
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers).not.toHaveProperty("authorization");
    const body = JSON.parse(call.body);
    expect(body.tool_choice).toEqual({ type: "tool", name: "report" });
    expect(body.tools[0].input_schema).toEqual(SCHEMA);
    expect(body).toMatchObject({ system: "You review code.", max_tokens: 1000, temperature: 0 });
  });

  it("fails when there is no tool call or the output was cut off", async () => {
    const noTool = script(reply({ content: [{ type: "text", text: "hi" }] }));
    await expect(anthropic(noTool.transport).complete(request())).rejects.toBeInstanceOf(
      ProviderInvalidResponse,
    );
    await expect(
      anthropic(script(reply({ stop_reason: "max_tokens" })).transport).complete(request()),
    ).rejects.toThrow(/cut off/);
  });

  it("maps 401, 429 and 529 like the other adapters", async () => {
    await expect(
      anthropic(script({ status: 401 }).transport).complete(request()),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    const overloaded = script({ status: 529 }, reply());
    expect((await anthropic(overloaded.transport).complete(request())).retries).toBe(1);
    const limited = script({ status: 429, headers: { "retry-after": "1" } }, reply());
    expect((await anthropic(limited.transport).complete(request())).retries).toBe(1);
  });
});

describe("cancellation", () => {
  const hang: Step = (req) =>
    new Promise<HttpResponse>((_, reject) =>
      req.signal?.addEventListener("abort", () => reject(new TransportError("aborted"))),
    );

  it("aborts a request in flight without retrying", async () => {
    const { transport, calls } = script(hang);
    const controller = new AbortController();
    const pending = deepseek(transport).complete(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ProviderCancelled);
    expect(calls).toHaveLength(1);
  });

  it("does not start when the signal is already aborted", async () => {
    const { transport, calls } = script(ok());
    const err = await deepseek(transport)
      .complete(request({ signal: AbortSignal.abort() }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderCancelled);
    expect(calls).toHaveLength(0);
  });

  it("stops waiting between retries", async () => {
    const controller = new AbortController();
    const { transport, calls } = script({ status: 503 });
    const provider = createProvider({
      name: "deepseek",
      model: "m",
      apiKey: KEY,
      transport,
      retry: {
        sleep: (_ms, signal) =>
          new Promise((_, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason)),
          ),
      },
    });
    const pending = provider.complete(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ProviderCancelled);
    expect(calls).toHaveLength(1);
  });

  it("cancels a request that is still waiting for a concurrency slot", async () => {
    const governor = new RunGovernor({ concurrency: 1, maxRequests: 10, maxTotalTokens: 1e6 });
    const { transport, calls } = script(hang);
    const provider = deepseek(transport, { governor });
    const first = new AbortController();
    const second = new AbortController();
    const running = provider.complete(request({ signal: first.signal }));
    const waiting = provider.complete(request({ signal: second.signal }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    second.abort();
    await expect(waiting).rejects.toBeInstanceOf(ProviderCancelled);
    first.abort();
    await expect(running).rejects.toBeInstanceOf(ProviderCancelled);
    expect(calls).toHaveLength(1); // the cancelled waiter never reached the network
  });
});

describe("RunGovernor (FR-16)", () => {
  it("never runs more requests at once than the concurrency cap, across providers", async () => {
    const governor = new RunGovernor({ concurrency: 2, maxRequests: 100, maxTotalTokens: 1e9 });
    let inFlight = 0;
    let peak = 0;
    const slow = (name: "deepseek" | "openai"): Provider => ({
      name,
      model: "m",
      async complete() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { json: {}, usage: { inputTokens: 1, outputTokens: 1 }, model: "m", retries: 0 };
      },
    });
    const a = governor.wrap(slow("deepseek"));
    const b = governor.wrap(slow("openai"));
    await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).complete(request())));
    expect(peak).toBe(2);
    expect(governor.snapshot().requests).toBe(8);
  });

  it("stops starting requests once the request budget is spent", async () => {
    const governor = new RunGovernor({ concurrency: 3, maxRequests: 2, maxTotalTokens: 1e9 });
    const provider = governor.wrap(createMockProvider({ replies: [ANSWER] }));
    await provider.complete(request());
    await provider.complete(request());
    await expect(provider.complete(request())).rejects.toBeInstanceOf(ProviderBudgetExceeded);
    expect(governor.snapshot()).toMatchObject({ requests: 2, refused: 1 });
  });

  it("stops starting requests once the token budget is spent, using reported usage", async () => {
    const governor = new RunGovernor({ concurrency: 1, maxRequests: 100, maxTotalTokens: 5000 });
    const mock = createMockProvider({ usage: { inputTokens: 2000, outputTokens: 1500 } });
    const provider = governor.wrap(mock);
    await provider.complete(request({ maxOutputTokens: 100 }));
    // 3500 used; the next request needs its estimated input plus 2000 reserved for output.
    await expect(provider.complete(request({ maxOutputTokens: 2000 }))).rejects.toBeInstanceOf(
      ProviderBudgetExceeded,
    );
    expect(mock.calls).toHaveLength(1);
    expect(governor.snapshot().usage).toEqual({ inputTokens: 2000, outputTokens: 1500 });
  });

  it("reserves tokens for requests in flight so parallel agents cannot overshoot together", async () => {
    const governor = new RunGovernor({ concurrency: 2, maxRequests: 10, maxTotalTokens: 3000 });
    const provider = governor.wrap(
      createMockProvider({
        replies: [async () => (await new Promise((r) => setTimeout(r, 5)), {})],
      }),
    );
    const results = await Promise.allSettled([
      provider.complete(request({ maxOutputTokens: 2000 })),
      provider.complete(request({ maxOutputTokens: 2000 })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("releases the slot when a request fails", async () => {
    const governor = new RunGovernor({ concurrency: 1, maxRequests: 10, maxTotalTokens: 1e9 });
    const provider = governor.wrap(
      createMockProvider({ replies: [new ProviderUnavailable("x", "deepseek"), ANSWER] }),
    );
    await expect(provider.complete(request())).rejects.toBeInstanceOf(ProviderUnavailable);
    await expect(provider.complete(request())).resolves.toMatchObject({ json: ANSWER });
  });
});

describe("safety", () => {
  it("never leaks the key, prompts or response bodies into errors or logs", async () => {
    const lines: string[] = [];
    const logger = createLogger({}, (line) => lines.push(line));
    const echo = `{"error":{"message":"bad key ${KEY} for SECRET-PROMPT-TEXT"}}`;
    const failures: Step[] = [
      { status: 401, body: echo },
      { status: 400, body: echo },
      { status: 500, body: echo },
      { status: 200, body: echo },
      { status: 200, body: openaiBody(`{ ${KEY} `) },
      new Error(`connect failed using ${KEY}`),
    ];
    const messages: string[] = [];
    for (const step of failures) {
      const provider = deepseek(script(step).transport, { logger });
      const err = await provider.complete(request()).catch((e) => e);
      messages.push(String(err.message), String(err.stack ?? ""), JSON.stringify(err));
    }
    await deepseek(script(ok()).transport, { logger }).complete(request());

    const all = [...messages, ...lines].join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("0123456789abcdef");
    expect(all).not.toContain("SECRET-PROMPT-TEXT");
    expect(all).not.toContain("diff here");
  });

  it("logs which provider receives code, once, with the host only", () => {
    const lines: string[] = [];
    const logger = createLogger({}, (line) => lines.push(line));
    createProvider({
      name: "deepseek",
      model: "deepseek-flash",
      apiKey: KEY,
      logger,
      transport: script(ok()).transport,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("provider=deepseek");
    expect(lines[0]).toContain("host=api.deepseek.com");
  });

  it("logs only provider, model, sizes, status and duration for a request", async () => {
    const lines: string[] = [];
    const logger = createLogger({}, (line) => lines.push(line));
    await deepseek(script(ok()).transport, { logger }).complete(request());
    const line = lines.find((l) => l.includes("provider request"))!;
    expect(line).toMatch(/provider=deepseek/);
    expect(line).toMatch(/model=deepseek-flash/);
    expect(line).toMatch(/requestChars=\d+/);
    expect(line).toMatch(/status=ok/);
    expect(line).toMatch(/durationMs=\d+/);
  });

  it("re-checks a custom endpoint on every call and does not send when it is refused", async () => {
    const { transport, calls } = script(ok());
    const validateUrl = vi.fn(async () => ({ ok: false as const, reason: "private" }));
    const provider = createProvider({
      name: "deepseek",
      model: "m",
      apiKey: KEY,
      baseUrl: "https://llm.example.com",
      transport,
      validateUrl,
    });
    await expect(provider.complete(request())).rejects.toThrow(/endpoint is not allowed/);
    await expect(provider.complete(request())).rejects.toBeInstanceOf(ProviderUnavailable);
    expect(validateUrl).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(0);
  });

  it("refuses private and plain-http endpoints with the real validator", async () => {
    const { transport, calls } = script(ok());
    const make = (baseUrl: string) =>
      createProvider({ name: "openai", model: "m", apiKey: KEY, baseUrl, transport });
    expect(() => make("http://api.example.com")).toThrow(/https/);
    await expect(make("https://169.254.169.254/v1").complete(request())).rejects.toBeInstanceOf(
      ProviderUnavailable,
    );
    await expect(make("https://127.0.0.1:8443").complete(request())).rejects.toBeInstanceOf(
      ProviderUnavailable,
    );
    expect(calls).toHaveLength(0);
  });

  it("does not resolve the provider's own host (it is a constant)", async () => {
    const validateUrl = vi.fn();
    await deepseek(script(ok()).transport, { validateUrl }).complete(request());
    expect(validateUrl).not.toHaveBeenCalled();
  });

  it("the real transport refuses to connect to a loopback address (connection-time guard)", async () => {
    const transport = createHttpsTransport();
    await expect(
      transport({
        url: new URL("https://localhost:9/x"),
        headers: {},
        body: "{}",
        timeoutMs: 2000,
      }),
    ).rejects.toMatchObject({ kind: "network" });
  });

  describe("the real transport against a server that never answers", () => {
    async function silentServer() {
      const server = createServer(() => undefined); // accepts the connection, then says nothing
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      // Test seam: resolve to the local server, skipping the address guard.
      const lookup = ((_host: string, options: { all?: boolean }, cb: (...a: unknown[]) => void) =>
        options.all
          ? cb(null, [{ address: "127.0.0.1", family: 4 }])
          : cb(null, "127.0.0.1", 4)) as unknown as LookupFunction;
      const url = new URL(`https://silent.test:${(server.address() as AddressInfo).port}/x`);
      return { server, lookup, url };
    }

    it("gives up at the timeout", async () => {
      const { server, lookup, url } = await silentServer();
      try {
        const transport = createHttpsTransport({ lookup });
        await expect(
          transport({ url, headers: {}, body: "{}", timeoutMs: 100 }),
        ).rejects.toMatchObject({ kind: "timeout" });
      } finally {
        server.close();
      }
    });

    it("stops when the signal aborts", async () => {
      const { server, lookup, url } = await silentServer();
      try {
        const controller = new AbortController();
        const pending = createHttpsTransport({ lookup })({
          url,
          headers: {},
          body: "{}",
          timeoutMs: 10_000,
          signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 50);
        await expect(pending).rejects.toMatchObject({ kind: "aborted" });
      } finally {
        server.close();
      }
    });
  });

  it("the providers module never reads the environment, files or processes", () => {
    const dir = join(import.meta.dirname);
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/process\.env|node:fs|node:child_process/);
    }
  });
});

describe("createProvider", () => {
  it("builds every provider from the same arguments; only the arguments change", async () => {
    for (const name of ["deepseek", "openai", "anthropic"] as const) {
      const provider = createProvider({
        name,
        model: "m",
        apiKey: KEY,
        transport: script({ status: 401 }).transport,
      });
      expect(provider.name).toBe(name);
      expect(provider.model).toBe("m");
      await expect(provider.complete(request())).rejects.toBeInstanceOf(ProviderAuthError);
    }
  });

  it("rejects missing inputs without echoing them", () => {
    expect(() => createProvider({ name: "deepseek", model: "", apiKey: KEY })).toThrow(/model/);
    expect(() => createProvider({ name: "deepseek", model: "m", apiKey: "" })).toThrow(/key/);
    expect(() => createProvider({ name: "nope" as never, model: "m", apiKey: KEY })).toThrow(
      /Unknown provider/,
    );
  });

  it("exposes the default endpoints used by the credential probe", () => {
    expect(DEFAULT_BASE_URLS).toEqual({
      deepseek: "https://api.deepseek.com",
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com/v1",
    });
  });
});

describe("testConnection", () => {
  it("reports success after one minimal request", async () => {
    const { transport, calls } = script(ok({ ok: true }));
    const result = await testConnection(deepseek(transport));
    expect(result).toEqual({ ok: true, message: "The provider accepted the key and model." });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body).max_tokens).toBeLessThanOrEqual(64);
  });

  it.each([
    [{ status: 401 }, "The provider rejected the key."],
    [{ status: 429, headers: { "retry-after": "999" } }, "rate limiting"],
    [{ status: 404 }, "check the model name"],
    [new TransportError("network"), "could not be reached"],
    [new TransportError("timeout"), "timed out"],
  ] as Array<[Step, string]>)("gives a fixed sentence for %#", async (step, text) => {
    const result = await testConnection(deepseek(script(step).transport));
    expect(result.ok).toBe(false);
    expect(result.message).toContain(text);
    expect(result.message).not.toContain(KEY);
  });
});

describe("MockProvider", () => {
  it("replays scripted replies, records calls and honours the signal", async () => {
    const mock = createMockProvider({
      replies: [{ a: 1 }, new ProviderRateLimit("x", "deepseek"), (r) => ({ echo: r.user })],
    });
    expect((await mock.complete(request())).json).toEqual({ a: 1 });
    await expect(mock.complete(request())).rejects.toBeInstanceOf(ProviderRateLimit);
    expect((await mock.complete(request({ user: "hi" }))).json).toEqual({ echo: "hi" });
    expect(mock.calls).toHaveLength(3);
    await expect(mock.complete(request({ signal: AbortSignal.abort() }))).rejects.toBeInstanceOf(
      ProviderCancelled,
    );
  });
});

describe("schema helpers", () => {
  it("detects schemas OpenAI strict mode accepts", () => {
    expect(isStrictCompatible(SCHEMA)).toBe(true);
    expect(
      isStrictCompatible({
        type: "object",
        properties: { a: {} },
        required: [],
        additionalProperties: false,
      }),
    ).toBe(false);
    expect(isStrictCompatible({ type: "object", properties: {}, required: [] })).toBe(false);
    expect(
      isStrictCompatible({
        type: "object",
        properties: {
          list: { type: "array", items: { type: "object", properties: { x: {} }, required: [] } },
        },
        required: ["list"],
        additionalProperties: false,
      }),
    ).toBe(false);
  });

  it("builds a placeholder example from a schema", () => {
    expect(
      schemaExample({
        type: "object",
        properties: {
          n: { type: "number" },
          s: { type: "string" },
          b: { type: "boolean" },
          e: { enum: ["x", "y"] },
          l: { type: "array", items: { type: "object", properties: { k: { type: "string" } } } },
          o: { anyOf: [{ type: "null" }, { type: "string" }] },
        },
      }),
    ).toEqual({ n: 0, s: "string", b: false, e: "x", l: [{ k: "string" }], o: null });
  });
});
