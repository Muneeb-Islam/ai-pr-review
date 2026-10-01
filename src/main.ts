import * as core from "@actions/core";
import * as github from "@actions/github";
import { ACTION_NAME, CONFIG_PATH_DEFAULT } from "./constants";
import { ConfigError, loadConfig } from "./config/loader";
import { decide } from "./events/guards";
import { classifyEvent } from "./events/router";
import type { RouteDecision } from "./events/types";
import { createOctokit, fetchPullRequest, verifyAuth } from "./github/client";
import { createLogger, newRunId } from "./util/logger";

async function run(): Promise<void> {
  const { eventName, payload, repo } = github.context;
  const logger = createLogger({ run: newRunId() });
  logger.info(`${ACTION_NAME} started`, { event: eventName });

  const classification = classifyEvent({
    eventName,
    payload,
    prNumberInput: core.getInput("pr_number"),
  });
  if (classification.kind === "ignore") {
    logger.info("Ignoring event", { reason: classification.reason });
    return;
  }

  const { config, filePath } = loadConfig({
    workspace: process.env["GITHUB_WORKSPACE"] ?? process.cwd(),
    configPath: core.getInput("config_path") || CONFIG_PATH_DEFAULT,
    inputs: {
      provider: core.getInput("provider"),
      model: core.getInput("model"),
      baseUrl: core.getInput("base_url"),
      mode: core.getInput("mode"),
    },
  });
  // Config holds no secrets (API keys come from the environment). Free-text `instructions` is summarised.
  const { instructions, ...loggable } = config;
  logger.info("Config loaded", {
    source: filePath ? "file+inputs" : "defaults+inputs",
    instructionsChars: instructions.length,
  });
  logger.info(`Parsed config: ${JSON.stringify(loggable)}`);

  const token = core.getInput("github_token");
  if (token) core.setSecret(token);
  let octokit: ReturnType<typeof createOctokit> | undefined;
  const getOctokit = () => (octokit ??= createOctokit(token, logger));

  let decision: RouteDecision;
  if (classification.kind === "pr") {
    decision = decide(classification.trigger, classification.pr, config);
  } else {
    const pr = await fetchPullRequest(getOctokit(), repo, classification.prNumber);
    decision = decide(classification.trigger, pr, config);
  }

  if (decision.action === "skip") {
    logger.info("Skipping review", { reason: decision.reason });
    return;
  }

  const prLogger = logger.child({ pr: decision.pr.number });
  prLogger.info("Review routed", {
    trigger: decision.trigger,
    depth: decision.depth,
    base: decision.pr.baseRef,
    head: decision.pr.headSha.slice(0, 7),
    draft: decision.pr.isDraft,
  });
  prLogger.info(`Code from this PR will be sent to the "${config.provider}" provider.`);
  await verifyAuth(getOctokit(), prLogger);
  // Phase 2+ continues here: context collection, agents, publishing.
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ConfigError) {
    core.setFailed(message);
  } else {
    // Design �10: only config errors fail the step. Anything else is reported but non-blocking.
    core.error(`Unexpected error: ${message}`);
  }
});
