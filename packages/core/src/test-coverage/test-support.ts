import { crc32, deflateRawSync } from "node:zlib";

// Builders for the coverage tests. Not for production code.

export interface ZipSpec {
  name: string;
  data: string | Buffer;
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8;
  /** Lie in the headers, to build hostile archives. */
  declaredSize?: number;
  declaredCompressedSize?: number;
  crc?: number;
  flags?: number;
}

/** A well-formed zip in memory; the `ZipSpec` overrides make it hostile on purpose. */
export function makeZip(
  specs: ZipSpec[],
  options: { comment?: string; centralDirectoryEntries?: number } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const spec of specs) {
    const raw = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data, "utf8");
    const method = spec.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(spec.name, "utf8");
    const crc = spec.crc ?? crc32(raw);
    const size = spec.declaredSize ?? raw.length;
    const compressed = spec.declaredCompressedSize ?? body.length;
    const flags = spec.flags ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? "", "utf8");
  const end = Buffer.alloc(22);
  const entries = options.centralDirectoryEntries ?? specs.length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries, 8);
  end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, centralBytes, end, comment]);
}

/** The artifact `actions/upload-artifact` makes from `coverage/lcov.info`: one file at the archive root. */
export const lcovZip = (lcov: string, name = "lcov.info"): Buffer =>
  makeZip([{ name, data: lcov }]);

/** Hand-written LCOV for a file with `DA` lines given as [line, hits] pairs. */
export function lcovRecord(
  path: string,
  lines: Array<[number, number]>,
  extra: string[] = [],
): string {
  return [
    "TN:",
    `SF:${path}`,
    ...extra,
    ...lines.map(([line, hits]) => `DA:${line},${hits}`),
    `LF:${lines.length}`,
    `LH:${lines.filter(([, hits]) => hits > 0).length}`,
    "end_of_record",
  ].join("\n");
}
