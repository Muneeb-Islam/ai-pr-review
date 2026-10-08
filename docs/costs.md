# Costs: what a review sends and what it may cost

The platform charges nothing: reviews use the AI provider key of the installation, so the bill is the provider's. This page says how big a review is, gives **estimated** price ranges per provider, and lists what stops cost running away. Related: [privacy.md](privacy.md) (what is sent), [admin-guide.md](admin-guide.md#keys-quotas-and-cost) (limits and quotas), [pilot.md](pilot.md) (replacing these estimates with measurements).

> **These are estimates, not measurements of a bill.** The request sizes below come from the real prompts run against synthetic pull requests of the stated size (`acceptance/performance.test.ts`, with `ACCEPTANCE_REPORT=1`); the platform counts about four characters to a token, so a provider's own tokenizer will differ by tens of percent. Output length is assumed. The prices are a placeholder table (`apps/api/src/analytics/pricing.ts`), not a quote: providers change prices and model names often. **Replace the table's numbers with your provider's current prices before anyone budgets from this**, and replace this page's figures with the pilot's measured medians (the pilot report prints token use by size class).

## What decides the cost

- **Size of the change.** Only changed lines, their surrounding context, file paths, the pull request title and description are sent; never whole repositories. Lock files, generated, vendored and build files, binaries and secrets are not sent. The defaults cap a review at 40 files and 120,000 patch characters.
- **How many agents run.** Code review, test coverage and security each read the diff, so three agents send roughly three times the diff. Switch off the ones you do not want (`agents.*`). The optional final review adds a pass over the findings.
- **The model.** The same request costs ten times more on a large model than on a small one.
- **Re-runs.** Every push to an open pull request is a new review; superseded runs stop as soon as they are replaced.

## Typical sizes

Measured on synthetic pull requests, **all three agents on**, mock provider:

| Pull request | Patch characters | Model requests | Input tokens (estimated) |
|---|---|---|---|
| Small: 3 files | about 4,500 | 3 | about 8,800 |
| Medium: 15 files | about 30,000 | 3 | about 28,800 |
| At the configured limits: 40 files | about 118,000 | 6 | about 103,500 |

The fixed part (instructions and output format, about 1,800 tokens per agent) dominates small reviews; the diff dominates large ones. A pull request at the limits uses about a quarter of the default per-run token budget (400,000).

## Estimated cost per review

Output assumed at 1,000 to 2,000 tokens per request; prices from the placeholder table (US dollars per million tokens, input / output: DeepSeek 0.3 / 0.5, OpenAI 2.5 / 10, Anthropic 3 / 15):

| Pull request | DeepSeek | OpenAI | Anthropic |
|---|---|---|---|
| Small (3 files) | $0.004 to $0.006 | $0.05 to $0.08 | $0.07 to $0.12 |
| Medium (15 files) | $0.010 to $0.012 | $0.10 to $0.13 | $0.13 to $0.18 |
| At the limits (40 files) | $0.034 to $0.037 | $0.32 to $0.38 | $0.40 to $0.49 |

Multiply by the number of reviews: a repository with 20 pull requests a week and about three pushes each is 60 reviews a week. Turning off two of the three agents cuts the input roughly by a factor of three. The dashboard's **Analytics** page shows actual tokens and an estimated cost for your own runs, per repository, which is the figure to trust once there is data.

## What stops runaway usage

All of these are tested (see the acceptance traceability for AC-23, [acceptance.md](acceptance.md)):

| Control | Default | Effect |
|---|---|---|
| Size policy | 40 files, 120,000 characters | A larger pull request is reviewed in part, or skipped when more than five times over, with the reason in the summary. |
| Per-run request budget | 20 requests | The run stops asking the model, posts what it has, and says so. |
| Per-run token budget | 400,000 tokens, counting requests in flight | The same; parallel agents cannot overshoot together. |
| Per-run concurrency | 3 requests at once | Keeps one run inside the provider's rate limit. |
| Request timeout | 120 s | A hung request ends and the agent is reported as failed. |
| Daily quota per installation | 200 runs, 2,000,000 tokens (operator-set) | A run over the limit is recorded as skipped (`quota_exceeded`) and visible in the dashboard. |
| Queue limits | 100 waiting per installation, 2,000 in all | One more is recorded as skipped (`queue_limit`). |
| Fork pull requests | skipped; if enabled, 15 files, 40,000 characters, 8 requests, 120,000 tokens | A stranger's pull request cannot run up a large bill. |
| Rate limits | per address, per installation, per user | A webhook storm gets 429s, not reviews. |

Set your **provider's own spending limit** as well: it is the only control that does not depend on this software.
