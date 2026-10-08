// A tiny Prometheus-format registry for the counters this process increments itself (webhook results, HTTP
// statuses). Gauges that describe the platform (queue, runs, installations) are computed from the database and
// Redis at scrape time (`collect.ts`), so they are right whichever api instance is scraped and survive restarts.

type Labels = Record<string, string>;

const escapeLabel = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const labelText = (labels: Labels): string => {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;
};

export interface MetricFamily {
  name: string;
  help: string;
  type: "counter" | "gauge";
  samples: Array<{ labels?: Labels; value: number }>;
}

/** Text exposition format 0.0.4. Names and label values are the caller's responsibility to keep low-cardinality. */
export function renderMetrics(families: MetricFamily[]): string {
  const lines: string[] = [];
  for (const family of families) {
    if (family.samples.length === 0) continue;
    lines.push(`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      const value = Number.isFinite(sample.value) ? sample.value : 0;
      lines.push(`${family.name}${labelText(sample.labels ?? {})} ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Counters with a fixed set of label names. The number of distinct label values is bounded by the caller. */
export class Counters {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = JSON.stringify(Object.entries(labels).sort());
    const entry = this.values.get(key);
    if (entry) entry.value += by;
    else this.values.set(key, { labels, value: by });
  }

  family(): MetricFamily {
    return {
      name: this.name,
      help: this.help,
      type: "counter",
      samples: [...this.values.values()].map((v) => ({ labels: v.labels, value: v.value })),
    };
  }
}

/** What this api process counts on its own. */
export class ApiMetrics {
  readonly webhooks = new Counters(
    "aipr_webhook_requests_total",
    "Webhook requests by result (accepted, duplicate, invalid_signature, rate_limited, installation_rate_limited, bad_request).",
  );
  readonly http = new Counters(
    "aipr_http_requests_total",
    "Dashboard API requests by route pattern and status class.",
  );
  readonly rateLimited = new Counters(
    "aipr_http_rate_limited_total",
    "Dashboard API requests refused by a rate limit, by scope (ip, user).",
  );

  families(): MetricFamily[] {
    return [this.webhooks.family(), this.http.family(), this.rateLimited.family()];
  }
}
