// Outbound-request guard for the user-supplied provider `base_url` (design §6, §9: it is an SSRF surface).
//
// Rules: https only, no credentials in the URL, no loopback / private / link-local / metadata / reserved
// addresses, and the same checks again after DNS resolution (a public-looking hostname that resolves to
// 169.254.169.254 is refused). `createSafeLookup` repeats the resolution check at connection time, so a DNS
// answer that changes between validation and use (rebinding) cannot reach an internal address either.
import { lookup as dnsLookup } from "node:dns";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

/** Parses an IPv4 address into its four octets. */
function ipv4Octets(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : undefined;
}

function isForbiddenIpv4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 || // private
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, including the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 literal into eight 16-bit groups; undefined if it is malformed. */
function ipv6Groups(ip: string): number[] | undefined {
  if (ip.includes("%")) return undefined; // zone ids are never legitimate here
  let text = ip;
  // An embedded IPv4 tail (::ffff:1.2.3.4) counts as two groups.
  const tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const o = ipv4Octets(tail[1]!);
    if (!o) return undefined;
    text =
      text.slice(0, -tail[1]!.length) +
      (((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16));
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8) return undefined;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? undefined : nums;
}

function isForbiddenIpv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((x) => x === 0)) return true; // ::
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 1
  ) {
    return true; // ::1
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isForbiddenIpv4(v4(g6, g7)); // IPv4-mapped
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return true; // IPv4-compatible (deprecated) and everything else in ::/96
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isForbiddenIpv4(v4(g6, g7)); // NAT64
  }
  if (g0 === 0x2002) return isForbiddenIpv4(v4(g1, g2)); // 6to4 embeds an IPv4 address
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local
    (g0 & 0xffc0) === 0xfe80 || // link-local
    (g0 & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) // discard-only
  );
}

/** True for any address a user-supplied URL must never reach. Unparseable input counts as forbidden. */
export function isForbiddenAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const octets = ipv4Octets(ip);
    return !octets || isForbiddenIpv4(octets);
  }
  if (version === 6) {
    const groups = ipv6Groups(ip);
    return !groups || isForbiddenIpv6(groups);
  }
  return true;
}

const FORBIDDEN_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".lan",
  ".home.arpa",
];

export type Resolver = (hostname: string) => Promise<string[]>;

/** Every address (A and AAAA) the hostname resolves to. */
export const systemResolver: Resolver = async (hostname) =>
  (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export type BaseUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Validates a provider `base_url`. The reasons are written for the person editing the setting; they never
 * include what the hostname resolved to.
 */
export async function validateBaseUrl(
  raw: string,
  options: { resolve?: Resolver } = {},
): Promise<BaseUrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "base_url must be a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "base_url must use https://" };
  if (url.username || url.password) {
    return { ok: false, reason: "base_url must not contain credentials" };
  }

  // The URL parser has already normalised hex, octal and decimal IPv4 forms (https://2130706433/).
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (host === "") return { ok: false, reason: "base_url must have a hostname" };
  if (host === "localhost" || FORBIDDEN_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "base_url must not point to a local or internal host" };
  }

  if (isIP(host)) {
    return isForbiddenAddress(host)
      ? {
          ok: false,
          reason: "base_url must not point to a private, loopback or link-local address",
        }
      : { ok: true, url };
  }

  let addresses: string[];
  try {
    addresses = await (options.resolve ?? systemResolver)(host);
  } catch {
    return { ok: false, reason: "base_url hostname could not be resolved" };
  }
  if (addresses.length === 0)
    return { ok: false, reason: "base_url hostname could not be resolved" };
  if (addresses.some(isForbiddenAddress)) {
    return {
      ok: false,
      reason: "base_url must not resolve to a private, loopback or link-local address",
    };
  }
  return { ok: true, url };
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * A `lookup` function for `https.request({ lookup })`: resolves like the system does but refuses to hand out
 * a forbidden address, so the connection itself is protected against DNS rebinding.
 */
export function createSafeLookup(
  resolve: (
    host: string,
    cb: (
      err: NodeJS.ErrnoException | null,
      addresses: Array<{ address: string; family: number }>,
    ) => void,
  ) => void = (host, cb) => dnsLookup(host, { all: true, verbatim: true }, cb),
) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname, (err, addresses) => {
      if (err) return callback(err);
      const blocked =
        addresses.length === 0 || addresses.some((a) => isForbiddenAddress(a.address));
      if (blocked) {
        const error: NodeJS.ErrnoException = new Error("Blocked outbound address");
        error.code = "EBLOCKED";
        return callback(error);
      }
      if (options.all) return callback(null, addresses);
      const first = addresses[0]!;
      return callback(null, first.address, first.family);
    });
  };
}
