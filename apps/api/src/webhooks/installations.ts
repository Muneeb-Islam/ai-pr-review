// Installation sync (PL-01, AC-22): installation lifecycle and repository selection events.
import { setRepositoriesActive, upsertRepository, type Run } from "@ai-pr-review/db";
import {
  deactivateInstallation,
  getInstallationByGitHubId,
  setInstallationStatus,
  upsertInstallationFromGitHub,
} from "@ai-pr-review/db/system";
import type { InstallationEvent, InstallationRepositoriesEvent } from "./payloads";
import { accountTypeOf } from "./target";
import { ignored, type HandlerResult, type WebhookDeps } from "./types";

const UNINSTALLED = "The GitHub App was uninstalled, so this review was stopped.";
const SUSPENDED = "The GitHub App was suspended, so this review was stopped.";

/**
 * Tells the dashboard and any worker that the runs stopped by an uninstall or suspension are cancelled. Their status
 * changed first, so a worker that is executing one has already lost its fence; the message makes it let go at once.
 */
async function announceStopped(deps: WebhookDeps, stopped: Run[]): Promise<void> {
  for (const run of stopped) {
    await deps.signals?.publishUpdated({
      runId: run.id,
      installationId: run.installationId,
      repoId: run.repoId,
      status: run.status,
    });
    await deps.signals?.publishCancel(run.id, "cancelled");
  }
}

export async function handleInstallation(
  deps: WebhookDeps,
  event: InstallationEvent,
): Promise<HandlerResult> {
  const githubInstallationId = event.installation.id;

  switch (event.action) {
    case "created": {
      const installation = await upsertInstallationFromGitHub(deps.db, {
        githubInstallationId,
        accountLogin: event.installation.account.login,
        accountType: accountTypeOf(event.installation.account.type),
        status: "active",
      });
      for (const repo of event.repositories ?? []) {
        await upsertRepository(deps.db, installation.id, {
          githubRepoId: repo.id,
          fullName: repo.full_name,
          isPrivate: repo.private,
        });
      }
      deps.logger.info("Installation created", {
        installation: githubInstallationId,
        repos: event.repositories?.length ?? 0,
      });
      return { outcome: "installation_created", installationId: installation.id };
    }

    case "deleted": {
      // Uninstalling deactivates the installation and its repositories (AC-22), stops what was waiting, forgets the
      // provider keys (a secret has no use once the App is gone) and who could see the data. The rest is hidden from
      // the dashboard and purged when retention ends (PL-08).
      const done = await deactivateInstallation(
        deps.db,
        githubInstallationId,
        "deleted",
        UNINSTALLED,
      );
      if (!done) return ignored("unknown_installation");
      await announceStopped(deps, done.stopped);
      deps.logger.info("Installation deleted", {
        installation: githubInstallationId,
        repos: done.repositories,
        stopped: done.stopped.length,
        keys: done.keys,
      });
      return { outcome: "installation_deleted", installationId: done.installationId };
    }

    case "suspend":
    case "unsuspend": {
      const status = event.action === "suspend" ? "suspended" : "active";
      // A suspended App cannot be reached on GitHub: stop what was waiting. Keys and access stay, because suspension
      // is reversible; the data is hidden from the dashboard for as long as it lasts.
      if (status === "suspended") {
        const done = await deactivateInstallation(
          deps.db,
          githubInstallationId,
          "suspended",
          SUSPENDED,
        );
        if (!done) return ignored("unknown_installation");
        await announceStopped(deps, done.stopped);
        deps.logger.info("Installation status changed", {
          installation: githubInstallationId,
          status,
          stopped: done.stopped.length,
        });
        return { outcome: "installation_suspended", installationId: done.installationId };
      }
      const installation = await setInstallationStatus(deps.db, githubInstallationId, status);
      if (!installation) return ignored("unknown_installation");
      deps.logger.info("Installation status changed", {
        installation: githubInstallationId,
        status,
      });
      return { outcome: "installation_active", installationId: installation.id };
    }

    default:
      return ignored("unsupported_action");
  }
}

export async function handleInstallationRepositories(
  deps: WebhookDeps,
  event: InstallationRepositoriesEvent,
): Promise<HandlerResult> {
  if (event.action !== "added" && event.action !== "removed") return ignored("unsupported_action");

  let installation = await getInstallationByGitHubId(deps.db, event.installation.id);
  if (!installation && event.installation.account) {
    installation = await upsertInstallationFromGitHub(deps.db, {
      githubInstallationId: event.installation.id,
      accountLogin: event.installation.account.login,
      accountType: accountTypeOf(event.installation.account.type),
      status: "active",
    });
  }
  if (!installation) return ignored("unknown_installation");
  if (installation.status === "deleted") return ignored("installation_inactive", installation.id);

  if (event.action === "added") {
    for (const repo of event.repositories_added) {
      await upsertRepository(deps.db, installation.id, {
        githubRepoId: repo.id,
        fullName: repo.full_name,
        isPrivate: repo.private,
      });
    }
    return { outcome: "repositories_added", installationId: installation.id };
  }

  await setRepositoriesActive(
    deps.db,
    installation.id,
    event.repositories_removed.map((r) => r.id),
    false,
  );
  return { outcome: "repositories_removed", installationId: installation.id };
}
