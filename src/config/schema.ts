import { z } from "zod";
import { SEVERITIES } from "../types/schema";

export const PROVIDERS = ["anthropic", "openai", "deepseek"] as const;
export const MODES = ["comment_only", "warn", "fail_on_threshold"] as const;
export const DRAFT_BEHAVIORS = ["summary_only", "full", "skip"] as const;
export const FORK_PR_POLICIES = ["skip", "read_only"] as const;

const positiveInt = z.number().int().positive();
const branchName = z.string().min(1);

// Section schemas use .prefault({}) so a missing section still gets every inner default.
const reviewSchema = z
  .strictObject({
    mode: z.enum(MODES).default("comment_only"),
    target_branches: z.array(branchName).min(1).default(["main", "master"]),
    draft_behavior: z.enum(DRAFT_BEHAVIORS).default("summary_only"),
    minimum_severity: z.enum(SEVERITIES).default("medium"),
    minimum_confidence: z.number().min(0).max(1).default(0.8),
    max_changed_files: positiveInt.default(40),
    max_patch_characters: positiveInt.default(120_000),
    max_inline_comments: positiveInt.default(20),
  })
  .prefault({});

const agentsSchema = z
  .strictObject({
    code_review: z.boolean().default(true),
    test_coverage: z.boolean().default(true),
    security: z.boolean().default(true),
    final_review: z.boolean().default(false),
  })
  .prefault({});

const limitsSchema = z
  .strictObject({
    concurrency: positiveInt.default(3),
    max_requests: positiveInt.default(20),
    max_total_tokens: positiveInt.default(400_000),
    request_timeout_ms: positiveInt.default(120_000),
  })
  .prefault({});

const coverageSchema = z
  .strictObject({
    lcov_path: z.string().min(1).default("coverage/lcov.info"),
  })
  .prefault({});

/** `.github/ai-pr-review.yml` (docs/design.md §5). Unknown keys are errors. */
export const configSchema = z.strictObject({
  provider: z.enum(PROVIDERS),
  model: z.string().min(1),
  base_url: z.url().optional(),
  review: reviewSchema,
  agents: agentsSchema,
  limits: limitsSchema,
  coverage: coverageSchema,
  fork_prs: z.enum(FORK_PR_POLICIES).default("skip"),
  ignore: z.array(z.string().min(1)).default(["dist/**", "coverage/**", "**/*.lock"]),
  secret_paths: z.array(z.string().min(1)).default(["**/.env*"]),
  instructions: z.string().default(""),
});

export type ResolvedConfig = z.output<typeof configSchema>;
