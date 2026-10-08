// CSV for the export (PL-08). Values come from pull requests and model output, so a cell can hold anything,
// including text a spreadsheet would run as a formula (`=HYPERLINK(...)`). Text cells that start that way get an
// apostrophe in front, which spreadsheets show as plain text, and everything is quoted per RFC 4180.

/** Byte order mark: tells Excel the file is UTF-8. */
const BOM = String.fromCharCode(0xfeff);

export type Cell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(cells: readonly Cell[]): string {
  return cells.map(csvCell).join(",");
}

/** The whole file: a header and the rows, CRLF-separated, with a byte order mark so Excel reads UTF-8. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly Cell[]>): string {
  return `${BOM}${[csvRow(header), ...rows.map(csvRow)].join("\r\n")}\r\n`;
}
