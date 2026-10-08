// Scheduled reconciliation with GitHub (design §16, "installation access refresh", AC-22): webhooks are the primary
// way the platform learns that an installation changed, but a webhook can be lost (an outage, a delivery that GitHub
// gave up on). Once in a while, for every active installation, ask GitHub what the installation really covers:
//
//  - repositories GitHub lists that are unknown, or were deactivated, are added or reactivated;
//  - repositories we hold as active that GitHub no longer lists are deactivated (no more runs for them);
//  - an installation GitHub no longer knows (404) was uninstalled while we were not looking: the uninstall flow runs.
//
// Users' access caches are not refreshed here: they are verified on use, within `ACCESS_CACHE_TTL_SECONDS`.
import { listRepositories, upsertRepository, setRepositoriesActive } from "@ai-pr-review/db";
import type { Database } from "@ai-pr-review/db";
import { deactivateInstallation, listActiveInstallations } from "@ai-pr-review/db/system";
import type { RunSignals } from "@ai-pr-review/queue";
import type { Logger } from "@ai-pr-review/shared";

export interface RemoteRepository {
  id: number;
  fullName: string;
  isPrivate: boolean;
  defaultBranch?: string;
}

/** Thrown by `listRepositories` when GitHub says the installation does not exist (any more). */
export class InstallationGoneError extends Error {
  constructor() {
    super("The installation no longer exists on GitHub.");
    this.name = "InstallationGoneError";
  }
}

export interface InstallationSyncOptions {
  db: Database;
  signals: RunSignals;
  logger: Logger;
  /** The repositories an installation covers, from GitHub. Throws `InstallationGoneError` for a missing installation. */
  listRemoteRepositories(githubInstallationId: number): Promise<RemoteRepository[]>;
}

export interface SyncResult {
  installations: number;
  added: number;
  removed: number;
  uninstalled: number;
  failed: number;
}

const UNINSTALLED = "The GitHub App was uninstalled, so this review was stopped.";

export class InstallationSync {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly options: InstallationSyncOptions) {}

  /** One pass over every active installation. One that fails does not stop the others. */
  async syncOnce(): Promise<SyncResult> {
    const { db, logger } = this.options;
    const result: SyncResult = {
      installations: 0,
      added: 0,
      removed: 0,
      uninstalled: 0,
      failed: 0,
    };

    const missing: Array<{ id: string; githubInstallationId: number }> = [];
    const all = await listActiveInstallations(db);
    for (const installation of all) {
      result.installations++;
      try {
        const remote = await this.options.listRemoteRepositories(installation.githubInstallationId);
        const known = await listRepositories(db, [installation.id], {});
        const knownActive = new Map(known.filter((r) => r.active).map((r) => [r.githubRepoId, r]));
        const remoteIds = new Set(remote.map((r) => r.id));

        for (const repo of remote) {
          const existing = known.find((r) => r.githubRepoId === repo.id);
          if (existing?.active && existing.fullName === repo.fullName) continue;
          await upsertRepository(db, installation.id, {
            githubRepoId: repo.id,
            fullName: repo.fullName,
            isPrivate: repo.isPrivate,
            ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}),
          });
          if (!existing?.active) result.added++;
        }
        const gone = [...knownActive.keys()].filter((id) => !remoteIds.has(id));
        if (gone.length > 0) {
          result.removed += await setRepositoriesActive(db, installation.id, gone, false);
        }
      } catch (err) {
        if (err instanceof InstallationGoneError) {
          missing.push(installation);
          continue;
        }
        result.failed++;
        // Name only: an error from the HTTP client can quote the request.
        logger.warn("Installation sync failed; trying again at the next pass", {
          installation: installation.githubInstallationId,
          error: err instanceof Error ? err.name : "unknown",
        });
      }
    }

    // Uninstalling deletes provider keys, so be sure. If most installations look gone at once the cause is more likely
    // ours (credentials of another App, a GitHub incident) than a wave of uninstalls: change nothing and say so.
    const suspicious = missing.length > 2 && missing.length * 2 > all.length;
    if (suspicious) {
      result.failed += missing.length;
      logger.error(
        "GitHub reports most installations as gone; not acting on it. Check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY",
        { missing: missing.length, installations: all.length },
      );
    } else {
      for (const installation of missing) {
        const done = await deactivateInstallation(
          db,
          installation.githubInstallationId,
          "deleted",
          UNINSTALLED,
        );
        for (const run of done?.stopped ?? []) {
          await this.options.signals.publishUpdated({
            runId: run.id,
            installationId: run.installationId,
            repoId: run.repoId,
            status: run.status,
          });
          await this.options.signals.publishCancel(run.id, "cancelled");
        }
        result.uninstalled++;
        logger.warn("An installation was uninstalled on GitHub without a webhook reaching us", {
          installation: installation.githubInstallationId,
        });
      }
    }

    if (result.added + result.removed + result.uninstalled > 0) {
      logger.info("Installation sync corrected differences with GitHub", {
        added: result.added,
        removed: result.removed,
        uninstalled: result.uninstalled,
      });
    }
    return result;
  }

  /** Every `intervalMs`, starting after one interval (the first pass is not needed at start-up). */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.syncOnce()
        .catch(() => this.options.logger.warn("Installation sync failed; trying again later"))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
