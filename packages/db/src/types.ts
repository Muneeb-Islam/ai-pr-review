import type {
  agentRuns,
  auditLog,
  findingFeedback,
  findings,
  installationSettings,
  installations,
  postedComments,
  providerCredentials,
  repoSettings,
  repositories,
  reviewRuns,
} from "./schema";

// Row types handed to callers. Timestamps are Dates here; the API layer serialises them.
export type Installation = typeof installations.$inferSelect;
export type Repo = typeof repositories.$inferSelect;
export type RepoSettingsRecord = typeof repoSettings.$inferSelect;
export type InstallationSettingsRecord = typeof installationSettings.$inferSelect;
export type Run = typeof reviewRuns.$inferSelect;
export type AgentRunRecord = typeof agentRuns.$inferSelect;
export type StoredFinding = typeof findings.$inferSelect;
export type PostedComment = typeof postedComments.$inferSelect;
export type FeedbackRecord = typeof findingFeedback.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;

/** What callers may see of a provider key: never the ciphertext (design §9). */
export type CredentialInfo = Omit<typeof providerCredentials.$inferSelect, "ciphertext">;
