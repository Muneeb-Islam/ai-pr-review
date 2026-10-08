import { describe, expect, it } from "vitest";
import { createSafeLookup, isForbiddenAddress, validateBaseUrl, type Resolver } from "./ssrf";

const resolvesTo =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses;

describe("isForbiddenAddress", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
    "2001:db8::1",
    "not-an-ip",
    "",
  ])("refuses %s", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.0.1",
    "100.128.0.1",
    "169.253.0.1",
    "104.18.2.55",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",
  ])("allows %s", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false);
  });
});

describe("validateBaseUrl", () => {
  const publicHost = resolvesTo("104.18.2.55");

  it("accepts an https URL that resolves to public addresses", async () => {
    const result = await validateBaseUrl("https://api.deepseek.com/v1", { resolve: publicHost });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["http://api.deepseek.com", "https://"],
    ["ftp://api.deepseek.com", "https://"],
    ["not a url", "valid URL"],
    ["https://user:pass@api.deepseek.com", "credentials"],
    ["https://localhost/v1", "local or internal"],
    ["https://LOCALHOST./v1", "local or internal"],
    ["https://app.localhost/v1", "local or internal"],
    ["https://db.internal/v1", "local or internal"],
    ["https://printer.local/v1", "local or internal"],
    ["https://127.0.0.1/v1", "private"],
    ["https://169.254.169.254/latest/meta-data", "private"],
    ["https://10.1.2.3/", "private"],
    ["https://192.168.0.5:8443/", "private"],
    ["https://172.20.1.1/", "private"],
    ["https://[::1]/", "private"],
    ["https://[fd00::1]/", "private"],
    ["https://[::ffff:127.0.0.1]/", "private"],
    ["https://2130706433/", "private"], // decimal form of 127.0.0.1
    ["https://0x7f000001/", "private"], // hex form
    ["https://0177.0.0.1/", "private"], // octal form
    ["https://127.1/", "private"], // short form
  ])("rejects %s", async (raw, reason) => {
    const result = await validateBaseUrl(raw, { resolve: publicHost });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it.each([
    ["loopback", ["127.0.0.1"]],
    ["metadata", ["169.254.169.254"]],
    ["private", ["10.0.0.7"]],
    ["IPv6 unique local", ["fd00::5"]],
    ["one bad address among good ones", ["104.18.2.55", "192.168.1.1"]],
  ])("rejects a hostname that resolves to %s", async (_name, addresses) => {
    const result = await validateBaseUrl("https://innocent.example.com/v1", {
      resolve: resolvesTo(...addresses),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("resolve");
      // The resolved address is not echoed back.
      for (const address of addresses) expect(result.reason).not.toContain(address);
    }
  });

  it("rejects a hostname that does not resolve", async () => {
    const failing: Resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    expect((await validateBaseUrl("https://nope.example.com", { resolve: failing })).ok).toBe(
      false,
    );
    expect((await validateBaseUrl("https://nope.example.com", { resolve: resolvesTo() })).ok).toBe(
      false,
    );
  });
});

describe("createSafeLookup (connection-time guard against DNS rebinding)", () => {
  const lookupOf = (addresses: Array<{ address: string; family: number }>) =>
    createSafeLookup((_host, cb) => cb(null, addresses));

  it("hands out public addresses", async () => {
    const lookup = lookupOf([{ address: "104.18.2.55", family: 4 }]);
    const result = await new Promise((resolve, reject) =>
      lookup("api.example.com", {}, (err, address, family) =>
        err ? reject(err) : resolve({ address, family }),
      ),
    );
    expect(result).toEqual({ address: "104.18.2.55", family: 4 });
  });

  it("refuses when any answer is internal", async () => {
    const lookup = lookupOf([
      { address: "104.18.2.55", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    const error = await new Promise<NodeJS.ErrnoException>((resolve) =>
      lookup("rebind.example.com", { all: true }, (err) => resolve(err!)),
    );
    expect(error.code).toBe("EBLOCKED");
  });
});
