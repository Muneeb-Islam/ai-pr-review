import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DEFAULT_ZIP_LIMITS, readZipEntry, ZipError, type ZipLimits } from "./zip";
import { makeZip } from "./test-support";

const limits = (over: Partial<ZipLimits> = {}): ZipLimits => ({ ...DEFAULT_ZIP_LIMITS, ...over });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ZipError) return err.code;
    throw err;
  }
  return undefined;
}

describe("readZipEntry: ordinary archives", () => {
  it("reads a deflated file", () => {
    const zip = makeZip([{ name: "lcov.info", data: "SF:a.ts\nend_of_record\n" }]);
    const entry = readZipEntry(zip, { path: "lcov.info" });
    expect(entry?.name).toBe("lcov.info");
    expect(entry?.data.toString()).toBe("SF:a.ts\nend_of_record\n");
  });

  it("reads a stored file and picks the right one among several", () => {
    const zip = makeZip([
      { name: "index.html", data: "<html>", method: 0 },
      { name: "lcov-report/base.css", data: "body{}" },
      { name: "lcov.info", data: "SF:b.ts\nend_of_record\n", method: 0 },
    ]);
    expect(readZipEntry(zip, { path: "lcov.info" })?.data.toString()).toContain("SF:b.ts");
  });

  it("tolerates Windows separators and a ./ prefix in the entry name", () => {
    const zip = makeZip([{ name: ".\\coverage\\lcov.info", data: "SF:a.ts\nend_of_record\n" }]);
    expect(readZipEntry(zip, { path: "coverage/lcov.info" })?.name).toBe("coverage/lcov.info");
  });

  it("returns undefined when the file is not there", () => {
    const zip = makeZip([{ name: "other.txt", data: "x" }]);
    expect(readZipEntry(zip, { path: "lcov.info" })).toBeUndefined();
  });

  it("falls back to the one file with the same name in another directory, only when asked", () => {
    const zip = makeZip([{ name: "coverage/lcov.info", data: "SF:a.ts\nend_of_record\n" }]);
    expect(readZipEntry(zip, { path: "lcov.info" })).toBeUndefined();
    expect(readZipEntry(zip, { path: "lcov.info", fallbackToBasename: true })?.name).toBe(
      "coverage/lcov.info",
    );
  });

  it("refuses to pick between two files with the same name", () => {
    const zip = makeZip([
      { name: "a/lcov.info", data: "SF:a.ts\nend_of_record\n" },
      { name: "b/lcov.info", data: "SF:b.ts\nend_of_record\n" },
    ]);
    expect(codeOf(() => readZipEntry(zip, { path: "lcov.info", fallbackToBasename: true }))).toBe(
      "ambiguous",
    );
  });

  it("reads an archive that has a trailing comment", () => {
    const zip = makeZip([{ name: "lcov.info", data: "SF:a.ts\nend_of_record\n" }], {
      comment: "made by upload-artifact",
    });
    expect(readZipEntry(zip, { path: "lcov.info" })?.data.length).toBeGreaterThan(0);
  });
});

describe("readZipEntry: broken archives", () => {
  it.each([
    ["empty", Buffer.alloc(0)],
    ["too short", Buffer.from("PK")],
    ["random bytes", Buffer.from("this is certainly not a zip archive at all, just text")],
  ])("rejects %s", (_name, bytes) => {
    expect(codeOf(() => readZipEntry(bytes, { path: "lcov.info" }))).toBe("invalid");
  });

  it("rejects a truncated archive", () => {
    const zip = makeZip([{ name: "lcov.info", data: "SF:a.ts\nend_of_record\n".repeat(50) }]);
    expect(
      codeOf(() => readZipEntry(zip.subarray(0, zip.length - 40), { path: "lcov.info" })),
    ).toBe("invalid");
  });

  it("rejects an entry whose content does not match its checksum", () => {
    const zip = makeZip([{ name: "lcov.info", data: "SF:a.ts\n", crc: 12345 }]);
    expect(codeOf(() => readZipEntry(zip, { path: "lcov.info" }))).toBe("invalid");
  });

  it("rejects a central directory that points outside the archive", () => {
    const zip = makeZip([{ name: "lcov.info", data: "x" }]);
    const broken = Buffer.from(zip);
    broken.writeUInt32LE(0x7fffff00, broken.length - 22 + 16); // central directory offset
    expect(codeOf(() => readZipEntry(broken, { path: "lcov.info" }))).toBe("invalid");
  });

  it("rejects an archive that claims more entries than it holds", () => {
    const zip = makeZip([{ name: "lcov.info", data: "x" }], { centralDirectoryEntries: 5 });
    expect(codeOf(() => readZipEntry(zip, { path: "lcov.info" }))).toBe("invalid");
  });
});

describe("readZipEntry: hostile archives", () => {
  it("refuses an archive over the size cap before reading it", () => {
    const zip = makeZip([{ name: "lcov.info", data: "x".repeat(2000), method: 0 }]);
    expect(
      codeOf(() => readZipEntry(zip, { path: "lcov.info" }, limits({ maxArchiveBytes: 500 }))),
    ).toBe("too_large");
  });

  it("refuses an archive with too many entries", () => {
    const zip = makeZip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, data: "x" })));
    expect(codeOf(() => readZipEntry(zip, { path: "f1.txt" }, limits({ maxEntries: 10 })))).toBe(
      "too_many_entries",
    );
  });

  it("refuses an archive whose declared unpacked size is over the cap", () => {
    const zip = makeZip([
      { name: "a.bin", data: Buffer.alloc(600, 1) },
      { name: "b.bin", data: Buffer.alloc(600, 2) },
      { name: "lcov.info", data: "x" },
    ]);
    expect(
      codeOf(() =>
        readZipEntry(zip, { path: "lcov.info" }, limits({ maxTotalUncompressedBytes: 1000 })),
      ),
    ).toBe("too_large");
  });

  it("refuses an entry over the per-file cap", () => {
    const zip = makeZip([{ name: "lcov.info", data: "x".repeat(5000) }]);
    expect(
      codeOf(() => readZipEntry(zip, { path: "lcov.info" }, limits({ maxEntryBytes: 1000 }))),
    ).toBe("too_large");
  });

  it("refuses a zip bomb by compression ratio without inflating it", () => {
    // 20 MB of zeros deflates to about 20 KB: a ratio of 1000.
    const zip = makeZip([{ name: "lcov.info", data: Buffer.alloc(20 * 1024 * 1024) }]);
    expect(zip.length).toBeLessThan(40 * 1024);
    expect(codeOf(() => readZipEntry(zip, { path: "lcov.info" }))).toBe("bomb");
  });

  it("stops an entry that inflates to more than its header declares", () => {
    // The header says 10 bytes; the stream holds 5 MB. The cap is the declared size, so it never gets that far.
    const payload = Buffer.alloc(5 * 1024 * 1024, 65);
    const zip = makeZip([{ name: "lcov.info", data: payload, declaredSize: 10 }]);
    expect(codeOf(() => readZipEntry(zip, { path: "lcov.info" }, limits({ maxRatio: 1e9 })))).toBe(
      "bomb",
    );
  });

  it("refuses an entry whose real size differs from the declared one", () => {
    const zip = makeZip([
      { name: "lcov.info", data: "SF:a.ts\nend_of_record\n", declaredSize: 400 },
    ]);
    expect(codeOf(() => readZipEntry(zip, { path: "lcov.info" }))).toBe("invalid");
  });

  it("refuses encrypted entries", () => {
    const zip = makeZip([{ name: "lcov.info", data: "SF:a.ts\n", flags: 0x1 }]);
    expect(codeOf(() => readZipEntry(zip, { path: "lcov.info" }))).toBe("unsupported");
  });

  it("refuses ZIP64 archives", () => {
    const zip = makeZip([{ name: "lcov.info", data: "x" }]);
    const z64 = Buffer.from(zip);
    z64.writeUInt16LE(0xffff, z64.length - 22 + 10); // total entries marker
    z64.writeUInt16LE(0xffff, z64.length - 22 + 8);
    expect(codeOf(() => readZipEntry(z64, { path: "lcov.info" }))).toBe("unsupported");
  });

  it("refuses a compression method it does not implement", () => {
    const zip = makeZip([{ name: "lcov.info", data: "x" }]);
    const odd = Buffer.from(zip);
    // method field in the central directory (offset 10 of its header)
    const central = odd.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    odd.writeUInt16LE(14, central + 10); // LZMA
    expect(codeOf(() => readZipEntry(odd, { path: "lcov.info" }))).toBe("unsupported");
  });

  it("never reads an entry whose name could escape a directory", () => {
    const zip = makeZip([
      { name: "../lcov.info", data: "SF:evil.ts\nend_of_record\n" },
      { name: "/etc/lcov.info", data: "SF:evil.ts\nend_of_record\n" },
      { name: "C:\\lcov.info", data: "SF:evil.ts\nend_of_record\n" },
      { name: "a/../../lcov.info", data: "SF:evil.ts\nend_of_record\n" },
    ]);
    expect(readZipEntry(zip, { path: "lcov.info", fallbackToBasename: true })).toBeUndefined();
    expect(readZipEntry(zip, { path: "../lcov.info" })).toBeUndefined();
  });

  it("does not write anything: the module has no filesystem access", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of [
      "zip.ts",
      "artifact.ts",
      "lcov.ts",
      "paths.ts",
      "compute.ts",
      "measure.ts",
    ]) {
      const source = readFileSync(join(__dirname, file), "utf8");
      expect(source, file).not.toMatch(/node:fs|node:child_process|process\.env|tmpdir|writeFile/);
    }
  });

  it("keeps messages free of archive content", () => {
    const zip = makeZip([{ name: "lcov.info", data: "SECRET-CONTENT", crc: 1 }]);
    try {
      readZipEntry(zip, { path: "lcov.info" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("SECRET");
    }
  });

  it("is happy with a raw deflate stream that matches its header (sanity for the helper)", () => {
    const text = "SF:a.ts\nend_of_record\n";
    expect(deflateRawSync(Buffer.from(text)).length).toBeGreaterThan(0);
    expect(
      readZipEntry(makeZip([{ name: "lcov.info", data: text }]), {
        path: "lcov.info",
      })?.data.toString(),
    ).toBe(text);
  });
});
