import { and, asc, eq } from "drizzle-orm";
import type { AgentId, AgentRunStatus } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { agentRuns } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { AgentRunRecord } from "../types";
import { requireRun } from "./internal";

export interface NewAgentRun {
  agent: AgentId;
  status: AgentRunStatus;
  startedAt?: Date;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  retries: number;
  warnings: string[];
}

/** Records one agent's execution within a run of `installationId`. */
export async function recordAgentRun(
  db: Database,
  installationId: string,
  runId: string,
  input: NewAgentRun,
): Promise<AgentRunRecord> {
  await requireRun(db, installationId, runId);
  const [row] = await db
    .insert(agentRuns)
    .values({ ...input, startedAt: input.startedAt ?? null, installationId, runId })
    .returning();
  return row!;
}

export async function listAgentRuns(
  db: Database,
  installationIds: InstallationIds,
  runId: string,
): Promise<AgentRunRecord[]> {
  if (!isUuid(runId)) return [];
  return db
    .select()
    .from(agentRuns)
    .where(
      and(eq(agentRuns.runId, runId), inInstallations(agentRuns.installationId, installationIds)),
    )
    .orderBy(asc(agentRuns.startedAt), asc(agentRuns.agent), asc(agentRuns.id));
}
