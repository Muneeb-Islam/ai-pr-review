// Small, dependency-free charts for the analytics page (UI-07). Drawn as SVG with the theme's chart tokens, so
// they follow light and dark mode. Every chart has: a title, a legend when it has two or more series, a hover
// and keyboard tooltip, and a table view of the same numbers (identity and values never rest on colour alone).
import { useId, useState, type ReactNode } from "react";

export interface Series {
  name: string;
  /** A CSS colour, normally `var(--chart-1)`. */
  color: string;
}

export interface TableView {
  caption: string;
  columns: string[];
  rows: Array<Array<string | number>>;
}

/** A chart section: heading, legend, the plot, and the same data as a table behind a disclosure. */
export function ChartFrame({
  title,
  note,
  legend,
  table,
  children,
}: {
  title: string;
  note?: ReactNode;
  legend?: Series[];
  table: TableView;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`} className="card p-4">
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {title}
      </h3>
      {note ? <p className="text-muted mt-1 text-xs">{note}</p> : null}
      {legend && legend.length > 1 ? (
        <ul aria-label="Legend" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {legend.map((s) => (
            <li key={s.name} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: s.color }}
              />
              {s.name}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3">{children}</div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs">View as a table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{table.caption}</caption>
            <thead className="text-muted">
              <tr>
                {table.columns.map((c) => (
                  <th key={c} scope="col" className="py-1 pr-4 font-semibold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i} className="border-border border-t">
                  {row.map((cell, j) =>
                    j === 0 ? (
                      <th key={j} scope="row" className="py-1 pr-4 font-normal">
                        {cell}
                      </th>
                    ) : (
                      <td key={j} className="py-1 pr-4">
                        {cell}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

// ---------- geometry ----------

/** The plot is drawn on a 640 by 220 canvas and scaled; a chart that spans the page is drawn wider, so its text keeps its size. */
const DEFAULT_W = 640;
const H = 220;
const M = { left: 44, right: 8, top: 10, bottom: 28 };
const INNER_H = H - M.top - M.bottom;

/** The next "round" number at or above `max` (1, 2, 5 times a power of ten), so the axis ends on a clean tick. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (max <= step * power) return step * power;
  return 10 * power;
}

const ticksOf = (top: number) => [0, top / 2, top];

function Axes({
  top,
  format,
  labels,
  x,
  width,
}: {
  top: number;
  format: (n: number) => string;
  labels: string[];
  x: (i: number) => number;
  width: number;
}) {
  const step = Math.max(1, Math.ceil(labels.length / 8));
  return (
    <g>
      {ticksOf(top).map((t) => {
        const y = M.top + INNER_H - (t / top) * INNER_H;
        return (
          <g key={t}>
            <line
              x1={M.left}
              x2={width - M.right}
              y1={y}
              y2={y}
              stroke="var(--chart-grid)"
              strokeWidth="1"
            />
            <text x={M.left - 6} y={y + 3} textAnchor="end" fontSize="10" fill="var(--muted)">
              {format(t)}
            </text>
          </g>
        );
      })}
      {labels.map((label, i) =>
        i % step === 0 ? (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--muted)">
            {label}
          </text>
        ) : null,
      )}
    </g>
  );
}

function Tooltip({ at, lines }: { at: number; lines: string[] }) {
  // Keep it inside the plot: it flips to the left of the pointer in the right half.
  const right = at > 0.55;
  return (
    <div
      role="tooltip"
      className="card pointer-events-none absolute top-0 z-10 px-2 py-1 text-xs shadow"
      style={{
        left: `${at * 100}%`,
        transform: right ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
      }}
    >
      {lines.map((l, i) => (
        <div key={i} className={i === 0 ? "font-semibold" : ""}>
          {l}
        </div>
      ))}
    </div>
  );
}

// ---------- stacked bars ----------

/** Vertical bars, one per bucket, stacked by series. `values[i][s]` is series `s` in bucket `i`. */
export function StackedBars({
  labels,
  series,
  values,
  ariaLabel,
  format = (n) => String(n),
  width = DEFAULT_W,
}: {
  labels: string[];
  series: Series[];
  values: number[][];
  ariaLabel: string;
  format?: (n: number) => string;
  /** The canvas width: wider for a chart that spans the page. */
  width?: number;
}) {
  const innerW = width - M.left - M.right;
  const [active, setActive] = useState<number | null>(null);
  const totals = values.map((v) => v.reduce((a, b) => a + b, 0));
  const top = niceMax(Math.max(0, ...totals));
  const slot = innerW / Math.max(1, labels.length);
  const barW = Math.min(28, slot * 0.7);
  const x = (i: number) => M.left + slot * i + slot / 2;
  const scale = (n: number) => (n / top) * INNER_H;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${H}`}
        role="group"
        aria-label={ariaLabel}
        className="h-auto w-full"
      >
        <Axes top={top} format={format} labels={labels} x={x} width={width} />
        {labels.map((label, i) => {
          let y = M.top + INNER_H;
          return (
            <g
              key={i}
              tabIndex={0}
              role="img"
              aria-label={`${label}: ${series.map((s, k) => `${format(values[i]![k]!)} ${s.name.toLowerCase()}`).join(", ")}`}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              {/* A hit area wider than the bar, so a thin bar is easy to point at. */}
              <rect
                x={M.left + slot * i}
                y={M.top}
                width={slot}
                height={INNER_H}
                fill="transparent"
              />
              {series.map((s, k) => {
                const value = values[i]![k]!;
                if (value <= 0) return null;
                const height = scale(value);
                y -= height;
                // A 2px gap of the surface colour between stacked segments.
                return (
                  <rect
                    key={s.name}
                    x={x(i) - barW / 2}
                    y={y + 1}
                    width={barW}
                    height={Math.max(0, height - 2)}
                    rx="2"
                    fill={s.color}
                  />
                );
              })}
              {active === i ? (
                <rect
                  x={x(i) - barW / 2 - 2}
                  y={M.top}
                  width={barW + 4}
                  height={INNER_H}
                  fill="none"
                  stroke="var(--fg)"
                  strokeOpacity="0.4"
                  rx="2"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      {active !== null ? (
        <Tooltip
          at={x(active) / width}
          lines={[
            labels[active]!,
            ...series.map((s, k) => `${s.name}: ${format(values[active]![k]!)}`),
          ]}
        />
      ) : null}
    </div>
  );
}

// ---------- line ----------

/** One line over buckets; `null` is a bucket with nothing to measure (a gap, not a zero). */
export function LineChart({
  labels,
  values,
  color,
  ariaLabel,
  format,
  seriesName,
  reference,
  width = DEFAULT_W,
}: {
  labels: string[];
  values: Array<number | null>;
  color: string;
  ariaLabel: string;
  format: (n: number) => string;
  seriesName: string;
  /** A target drawn as a dashed line. */
  reference?: { value: number; label: string };
  width?: number;
}) {
  const innerW = width - M.left - M.right;
  const [active, setActive] = useState<number | null>(null);
  const measured = values.filter((v): v is number => v !== null);
  const top = niceMax(Math.max(0, reference?.value ?? 0, ...measured));
  const slot = innerW / Math.max(1, labels.length);
  const x = (i: number) => M.left + slot * i + slot / 2;
  const y = (n: number) => M.top + INNER_H - (n / top) * INNER_H;

  // Segments of consecutive measured buckets; a gap ends one.
  const segments: Array<Array<[number, number]>> = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const last = segments[segments.length - 1];
    if (last && values[i - 1] !== null && values[i - 1] !== undefined) last.push([x(i), y(v)]);
    else segments.push([[x(i), y(v)]]);
  });

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${H}`}
        role="group"
        aria-label={ariaLabel}
        className="h-auto w-full"
      >
        <Axes top={top} format={format} labels={labels} x={x} width={width} />
        {reference ? (
          <g>
            <line
              x1={M.left}
              x2={width - M.right}
              y1={y(reference.value)}
              y2={y(reference.value)}
              stroke="var(--muted)"
              strokeDasharray="4 4"
              strokeWidth="1.5"
            />
            <text
              x={width - M.right}
              y={y(reference.value) - 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--muted)"
            >
              {reference.label}
            </text>
          </g>
        ) : null}
        {segments.map((points, i) => (
          <polyline
            key={i}
            points={points.map(([px, py]) => `${px},${py}`).join(" ")}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {values.map((v, i) => (
          <g
            key={i}
            tabIndex={v === null ? undefined : 0}
            role={v === null ? undefined : "img"}
            aria-label={
              v === null ? undefined : `${labels[i]}: ${format(v)} ${seriesName.toLowerCase()}`
            }
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          >
            <rect
              x={M.left + slot * i}
              y={M.top}
              width={slot}
              height={INNER_H}
              fill="transparent"
            />
            {v !== null && (labels.length <= 31 || active === i) ? (
              <circle
                cx={x(i)}
                cy={y(v)}
                r={active === i ? 5 : 4}
                fill={color}
                stroke="var(--surface)"
                strokeWidth="2"
              />
            ) : null}
          </g>
        ))}
      </svg>
      {active !== null ? (
        <Tooltip
          at={x(active) / width}
          lines={[
            labels[active]!,
            `${seriesName}: ${values[active] === null ? "no data" : format(values[active]!)}`,
          ]}
        />
      ) : null}
    </div>
  );
}

// ---------- horizontal bars ----------

/** One row per category: a label, a bar and the number, so nothing is read off the colour. */
export function HBars({
  rows,
  color,
  ariaLabel,
  format = (n) => String(n),
}: {
  rows: Array<{ label: string; value: number }>;
  color: string;
  ariaLabel: string;
  format?: (n: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={ariaLabel} className="space-y-2">
      {rows.map((row) => (
        <li
          key={row.label}
          className="grid grid-cols-[minmax(7.5rem,13rem)_1fr_auto] items-center gap-2 text-sm"
        >
          <span>{row.label}</span>
          <span aria-hidden="true" className="bg-surface-2 block h-3 overflow-hidden rounded">
            <span
              className="block h-full rounded"
              style={{ width: `${(row.value / max) * 100}%`, background: color }}
            />
          </span>
          <span className="w-10 text-right tabular-nums">{format(row.value)}</span>
        </li>
      ))}
    </ul>
  );
}
