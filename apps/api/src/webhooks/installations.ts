// Installation sync (PL-01, AC-22): installation lifecycle and repository selection events.
import {
  setAllRepositoriesActive,
  setRepositoriesActive,
  upsertRepository,
} from "@ai-pr-review/db";
import {
  getInstallationByGitHubId,
  setInstallationStatus,
  upsertInstallationFromGitHub,
} from "@ai-pr-review/db/system";
import type { InstallationEvent, InstallationRepositoriesEvent } from "./payloads";
import { accountTypeOf } from "./target";
import { ignored, type HandlerResult, type WebhookDeps } from "./types";

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
      const installation = await setInstallationStatus(deps.db, githubInstallationId, "deleted");
      if (!installation) return ignored("unknown_installation");
      // Uninstalling deactivates the installation and its repositories: no further runs (AC-22).
      const repos = await setAllRepositoriesActive(deps.db, installation.id, false);
      deps.logger.info("Installation deleted", { installation: githubInstallationId, repos });
      return { outcome: "installation_deleted", installationId: installation.id };
    }

    case "suspend":
    case "unsuspend": {
      const status = event.action === "suspend" ? "suspended" : "active";
      const installation = await setInstallationStatus(deps.db, githubInstallationId, status);
      if (!installation) return ignored("unknown_installation");
      deps.logger.info("Installation status changed", {
        installation: githubInstallationId,
        status,
      });
      return { outcome: `installation_${status}`, installationId: installation.id };
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
