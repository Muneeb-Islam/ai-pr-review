import { useState } from "react";
import { useApi } from "../../app/api";

/** A date input value as the start or end of that day in the viewer's time zone (an ISO instant), or undefined. */
function dayBound(value: string, edge: "start" | "end"): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(edge === "start" ? `${value}T00:00:00` : `${value}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Download a repository's runs or findings as CSV (PL-08, admin). The download is a plain link: the browser sends
 * the session cookie and saves the file the api answers with. Every export is recorded in the audit log.
 */
export function ExportPanel({ repoId }: { repoId: string }) {
  const api = useApi();
  const [kind, setKind] = useState<"runs" | "findings">("runs");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const start = dayBound(from, "start");
  const end = dayBound(to, "end");
  const href = api.exportUrl(repoId, {
    kind,
    ...(start ? { from: start } : {}),
    ...(end ? { to: end } : {}),
  });

  return (
    <section aria-labelledby="export-title" className="card space-y-3 p-4">
      <div>
        <h2 id="export-title" className="text-base font-semibold">
          Export
        </h2>
        <p className="text-muted text-xs">
          A CSV file of this repository&apos;s history for a spreadsheet: up to 20,000 rows, without
          code excerpts. Each export is recorded in the audit log.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="export-kind" className="label">
            What to export
          </label>
          <select
            id="export-kind"
            className="field"
            value={kind}
            onChange={(e) => setKind(e.target.value as "runs" | "findings")}
          >
            <option value="runs">Runs</option>
            <option value="findings">Findings</option>
          </select>
        </div>
        <div>
          <label htmlFor="export-from" className="label">
            From
          </label>
          <input
            id="export-from"
            type="date"
            className="field"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="export-to" className="label">
            To
          </label>
          <input
            id="export-to"
            type="date"
            className="field"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <a className="btn btn-primary" href={href} download>
          Download CSV
        </a>
      </div>
    </section>
  );
}
