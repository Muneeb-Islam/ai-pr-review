import { crc32, inflateRawSync } from "node:zlib";

// A minimal, defensive ZIP reader for coverage artifacts (FR-22). The archive comes from a CI run that anyone who
// can open a pull request can influence, so it is treated as hostile: it is read in memory, never written to a
// directory, and the size of the archive, the number of entries, the declared and the real size of the one entry
// we extract, and its compression ratio are all capped. Only stored and deflated entries are supported, which is
// what `actions/upload-artifact` produces; encrypted, ZIP64 and split archives are refused.

export interface ZipLimits {
  /** Largest archive accepted, in bytes. */
  maxArchiveBytes: number;
  /** Largest sum of the entries' declared uncompressed sizes. */
  maxTotalUncompressedBytes: number;
  /** Largest entry we will inflate. */
  maxEntryBytes: number;
  maxEntries: number;
  /** Largest uncompressed-to-compressed ratio of the entry we inflate. */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxArchiveBytes: 50 * 1024 * 1024,
  maxTotalUncompressedBytes: 500 * 1024 * 1024,
  maxEntryBytes: 30 * 1024 * 1024,
  maxEntries: 20_000,
  maxRatio: 200,
};

export type ZipErrorCode =
  "invalid" | "unsupported" | "too_large" | "too_many_entries" | "bomb" | "ambiguous";

/** The archive cannot be read safely. The message is a fixed sentence and never quotes archive content. */
export class ZipError extends Error {
  constructor(
    readonly code: ZipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const CENTRAL_HEADER = 46;
const LOCAL_HEADER = 30;
const MAX_COMMENT = 0xffff;

interface Entry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const invalid = (): ZipError => new ZipError("invalid", "The artifact is not a valid zip archive.");

/** Forward slashes and no leading `./`, so `coverage\lcov.info` and `./coverage/lcov.info` compare equal. */
export function normalizeEntryName(name: string): string {
  let result = name.replaceAll("\\", "/");
  while (result.startsWith("./")) result = result.slice(2);
  return result;
}

/** An entry name that could escape a directory if the archive were ever extracted; such entries are never read. */
function isUnsafeName(name: string): boolean {
  return (
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").some((segment) => segment === "..") ||
    name.includes("\0")
  );
}

function readEntries(buffer: Buffer, limits: ZipLimits): Entry[] {
  if (buffer.length < EOCD_MIN) throw invalid();

  // The end-of-central-directory record is the last 22 bytes plus an optional comment of up to 64 KiB.
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buffer.length - EOCD_MIN; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw invalid();

  const disk = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const total = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== total) {
    throw new ZipError(
      "unsupported",
      "The artifact is a split zip archive, which is not supported.",
    );
  }
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError("unsupported", "The artifact uses ZIP64, which is not supported.");
  }
  if (total > limits.maxEntries) {
    throw new ZipError("too_many_entries", "The artifact contains too many files.");
  }
  if (cdOffset + cdSize > eocd) throw invalid();

  const entries: Entry[] = [];
  let position = cdOffset;
  let declaredTotal = 0;
  for (let n = 0; n < total; n += 1) {
    if (position + CENTRAL_HEADER > buffer.length) throw invalid();
    if (buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE) throw invalid();
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const next = position + CENTRAL_HEADER + nameLength + extraLength + commentLength;
    if (next > buffer.length) throw invalid();

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("unsupported", "The artifact uses ZIP64, which is not supported.");
    }
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalUncompressedBytes) {
      throw new ZipError("too_large", "The artifact is too large once unpacked.");
    }
    const name = buffer
      .subarray(position + CENTRAL_HEADER, position + CENTRAL_HEADER + nameLength)
      .toString("utf8");
    entries.push({ name, method, flags, crc, compressedSize, size, localOffset });
    position = next;
  }
  return entries;
}

function extract(buffer: Buffer, entry: Entry, limits: ZipLimits): Buffer {
  if (entry.flags & 0x1) {
    throw new ZipError("unsupported", "The artifact is encrypted, which is not supported.");
  }
  if (entry.size > limits.maxEntryBytes) {
    throw new ZipError("too_large", "A file in the artifact is too large.");
  }
  if (entry.compressedSize > 0 && entry.size / entry.compressedSize > limits.maxRatio) {
    throw new ZipError(
      "bomb",
      "A file in the artifact compresses suspiciously well and was not opened.",
    );
  }

  const header = entry.localOffset;
  if (header + LOCAL_HEADER > buffer.length || buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw invalid();
  }
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + LOCAL_HEADER + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw invalid();
  const data = buffer.subarray(start, end);

  let output: Buffer;
  if (entry.method === 0) {
    if (data.length !== entry.size) throw invalid();
    output = Buffer.from(data);
  } else if (entry.method === 8) {
    try {
      // The cap is the declared size plus one byte: a stream that inflates past what the header promised is a bomb
      // or a corrupt file, and either way stops here instead of filling memory.
      output = inflateRawSync(data, {
        maxOutputLength: Math.min(entry.size, limits.maxEntryBytes) + 1,
      });
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
        throw new ZipError(
          "bomb",
          "A file in the artifact is larger than it declares and was not opened.",
        );
      }
      throw invalid();
    }
  } else {
    throw new ZipError(
      "unsupported",
      "The artifact uses a compression method that is not supported.",
    );
  }

  if (output.length !== entry.size) throw invalid();
  if (crc32(output) !== entry.crc) throw invalid();
  return output;
}

export interface ZipEntryLookup {
  /** Path inside the archive to read. */
  path: string;
  /**
   * When `path` is not there, accept the one entry whose file name equals the last segment of `path` (an
   * `upload-artifact` of `coverage/` stores `lcov.info`, one of `./` stores `coverage/lcov.info`).
   */
  fallbackToBasename?: boolean;
}

export interface ZipEntryResult {
  /** The entry's name inside the archive. */
  name: string;
  data: Buffer;
}

/**
 * Reads one file from a zip held in memory, or returns `undefined` when the archive has no such file. Throws
 * `ZipError` for anything unsafe or unreadable.
 */
export function readZipEntry(
  archive: Uint8Array,
  lookup: ZipEntryLookup,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): ZipEntryResult | undefined {
  if (archive.byteLength > limits.maxArchiveBytes) {
    throw new ZipError("too_large", "The artifact is too large.");
  }
  const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const entries = readEntries(buffer, limits)
    .map((entry) => ({ ...entry, name: normalizeEntryName(entry.name) }))
    .filter((entry) => !entry.name.endsWith("/") && !isUnsafeName(entry.name));

  const wanted = normalizeEntryName(lookup.path);
  let matches = entries.filter((entry) => entry.name === wanted);
  if (matches.length === 0 && lookup.fallbackToBasename) {
    const base = wanted.slice(wanted.lastIndexOf("/") + 1);
    matches = entries.filter((entry) => entry.name.slice(entry.name.lastIndexOf("/") + 1) === base);
  }
  if (matches.length === 0) return undefined;
  // Two entries with one name: which one a tool would pick differs, so refuse to pick.
  if (matches.length > 1) {
    throw new ZipError("ambiguous", "The artifact contains more than one matching file.");
  }
  const entry = matches[0] as Entry;
  return { name: entry.name, data: extract(buffer, entry, limits) };
}
