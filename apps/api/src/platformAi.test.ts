// The platform-wide AI setting: platform administrators only, keys write-only and encrypted, one provider active.
import { credentialContext, decryptSecret } from "@ai-pr-review/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  createWorld,
  type Harness,
  type Session,
  type World,
} from "./testing/harness";

let h: Harness;
let world: World;
let alice: Session;
let victor: Session;

beforeAll(async () => {
  h = await createHarness(); // `alice` is a platform administrator in the harness
  world = await createWorld(h);
  alice = await h.signIn(world.alice);
  victor = await h.signIn(world.victor);
}, 60_000);
afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.t.pool.query("delete from platform_credentials");
  await h.t.pool.query("delete from platform_settings");
  h.clock.advance(61_000);
});

const KEY = "sk-platform-0123456789abcdefWXYZ";
const URL = "/api/platform/ai";
const putKey = (provider = "deepseek", api_key = KEY) =>
  h.request(alice, "PUT", `${URL}/credentials`, { body: { provider, api_key } });

describe("platform AI setting", () => {
  it("is refused to everyone who is not a platform administrator", async () => {
    expect((await h.request(victor, "GET", URL)).statusCode).toBe(403);
    expect(
      (
        await h.request(victor, "PUT", `${URL}/credentials`, {
          body: { provider: "deepseek", api_key: KEY },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("starts empty: three providers, no keys, none active", async () => {
    const res = await h.request(alice, "GET", URL);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { active_provider: string | null; providers: unknown[] };
    expect(body.active_provider).toBeNull();
    expect(body.providers).toHaveLength(3);
  });

  it("stores the key encrypted and only ever answers with its last four characters", async () => {
    const res = await putKey();
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(KEY);
    expect(res.json()).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ provider: "deepseek", last4: "WXYZ", model: null }),
      ]),
    });

    const { rows } = await h.t.pool.query(
      "select ciphertext, key_version from platform_credentials where provider = 'deepseek'",
    );
    expect(Buffer.from(rows[0].ciphertext).toString("utf8")).not.toContain(KEY);
    expect(
      decryptSecret(
        rows[0].ciphertext,
        rows[0].key_version,
        h.keyring,
        credentialContext({ installationId: "platform" }, "deepseek"),
      ),
    ).toBe(KEY);
  });

  it("activates a provider only once it has a key and a model", async () => {
    const noKey = await h.request(alice, "PATCH", URL, {
      body: { active_provider: "deepseek", models: { deepseek: "deepseek-chat" } },
    });
    expect(noKey.statusCode).toBe(400);

    await putKey();
    const noModel = await h.request(alice, "PATCH", URL, { body: { active_provider: "deepseek" } });
    expect(noModel.statusCode).toBe(400);

    const ok = await h.request(alice, "PATCH", URL, {
      body: { active_provider: "deepseek", models: { deepseek: "deepseek-chat" } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ active_provider: "deepseek" });
  });

  it("removing the active provider's key leaves no provider active", async () => {
    await putKey();
    await h.request(alice, "PATCH", URL, {
      body: { active_provider: "deepseek", models: { deepseek: "deepseek-chat" } },
    });

    const res = await h.request(alice, "DELETE", `${URL}/credentials?provider=deepseek`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ active_provider: null });
    expect(
      (await h.request(alice, "DELETE", `${URL}/credentials?provider=deepseek`)).statusCode,
    ).toBe(404);
  });
});
