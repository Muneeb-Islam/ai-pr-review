import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../client";
import { InvalidInputError } from "../errors";
import { repositories } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { Repo } from "../types";

export interface RepoFilters {
  /** Narrow to one of the caller's installations. */
  installationId?: string;
  enabled?: boolean;
  active?: boolean;
  /** Case-insensitive substring of `full_name`. */
  search?: string;
}

export async function listRepositories(
  db: Database,
  installationIds: InstallationIds,
  filters: RepoFilters = {},
): Promise<Repo[]> {
  if (filters.installationId !== undefined && !isUuid(filters.installationId)) return [];
  const search = filters.search?.trim();
  return db
    .select()
    .from(repositories)
    .where(
      and(
        inInstallations(repositories.installationId, installationIds),
        filters.installationId
          ? eq(repositories.installationId, filters.installationId)
          : undefined,
        filters.enabled === undefined ? undefined : eq(repositories.enabled, filters.enabled),
        filters.active === undefined ? undefined : eq(repositories.active, filters.active),
        search ? sql`position(lower(${search}) in lower(${repositories.fullName})) > 0` : undefined,
      ),
    )
    .orderBy(asc(repositories.fullName), asc(repositories.id));
}

export async function getRepository(
  db: Database,
  installationIds: InstallationIds,
  repoId: string,
): Promise<Repo | undefined> {
  if (!isUuid(repoId)) return undefined;
  const [row] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.id, repoId),
        inInstallations(repositories.installationId, installationIds),
      ),
    );
  return row;
}

/** Looks a repository up by its GitHub id (webhook payloads carry that, not our uuid). */
export async function getRepositoryByGitHubId(
  db: Database,
  installationIds: InstallationIds,
  githubRepoId: number,
): Promise<Repo | undefined> {
  if (!Number.isSafeInteger(githubRepoId)) return undefined;
  const [row] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.githubRepoId, githubRepoId),
        inInstallations(repositories.installationId, installationIds),
      ),
    );
  return row;
}

export interface RepositoryInput {
  githubRepoId: number;
  fullName: string;
  /**
   * Installation and repository-added webhooks do not carry the default branch. When it is omitted a new
   * row gets `main` and an existing row keeps what it has; pull request events carry the real value.
   */
  defaultBranch?: string;
  isPrivate: boolean;
}

const FALLBACK_DEFAULT_BRANCH = "main";

/**
 * Creates or refreshes a repository of one installation (installation and repository-added events).
 * A repository seen again becomes `active` again; `enabled` is an admin choice and is never touched here.
 */
export async function upsertRepository(
  db: Database,
  installationId: string,
  input: RepositoryInput,
): Promise<Repo> {
  if (!isUuid(installationId)) throw new InvalidInputError("installationId must be a uuid");
  const [row] = await db
    .insert(repositories)
    .values({
      installationId,
      githubRepoId: input.githubRepoId,
      fullName: input.fullName,
      defaultBranch: input.defaultBranch ?? FALLBACK_DEFAULT_BRANCH,
      isPrivate: input.isPrivate,
    })
    .onConflictDoUpdate({
      target: [repositories.installationId, repositories.githubRepoId],
      set: {
        fullName: input.fullName,
        ...(input.defaultBranch !== undefined ? { defaultBranch: input.defaultBranch } : {}),
        isPrivate: input.isPrivate,
        active: true,
      },
    })
    .returning();
  return row!;
}

/** Marks repositories (by GitHub id) active or inactive, e.g. on repository-removed events. */
export async function setRepositoriesActive(
  db: Database,
  installationId: string,
  githubRepoIds: readonly number[],
  active: boolean,
): Promise<number> {
  if (!isUuid(installationId) || githubRepoIds.length === 0) return 0;
  const rows = await db
    .update(repositories)
    .set({ active })
    .where(
      and(
        eq(repositories.installationId, installationId),
        inArray(repositories.githubRepoId, [...githubRepoIds]),
      ),
    )
    .returning({ id: repositories.id });
  return rows.length;
}

/** Deactivates (or reactivates) every repository of one installation, e.g. when the App is uninstalled. */
export async function setAllRepositoriesActive(
  db: Database,
  installationId: string,
  active: boolean,
): Promise<number> {
  if (!isUuid(installationId)) return 0;
  const rows = await db
    .update(repositories)
    .set({ active })
    .where(eq(repositories.installationId, installationId))
    .returning({ id: repositories.id });
  return rows.length;
}

export async function setRepositoryEnabled(
  db: Database,
  installationId: string,
  repoId: string,
  enabled: boolean,
): Promise<Repo | undefined> {
  if (!isUuid(installationId) || !isUuid(repoId)) return undefined;
  const [row] = await db
    .update(repositories)
    .set({ enabled })
    .where(and(eq(repositories.id, repoId), eq(repositories.installationId, installationId)))
    .returning();
  return row;
}
