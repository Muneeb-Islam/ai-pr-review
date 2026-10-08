// The repository file (`.github/ai-pr-review.yml`) as the settings screen shows it (design §6, UI-06): which
// settings it sets, so the form can lock them, and what is wrong with it if it cannot be used. Runs read the file
// at the base SHA of each pull request (core `loadEffectiveConfig`); this reads the default branch, which is where
// a change to the file lands, and caches the answer briefly so opening the screen does not call GitHub each time.
import { readRepoFile, type GitHubAppAuth } from "@ai-pr-review/core";
import { REPO_CONFIG_PATH, type RawConfig } from "@ai-pr-review/shared";

export interface RepoFileTarget {
  repoId: string;
  githubInstallationId: number;
  fullName: string;
  defaultBranch: string;
}

export interface RepoFileState {
  path: string;
  status: "applied" | "absent" | "invalid" | "unavailable";
  config: RawConfig;
  message: string | null;
}

export interface RepoFileReader {
  read(target: RepoFileTarget): Promise<RepoFileState>;
}

const UNAVAILABLE: RepoFileState = {
  path: REPO_CONFIG_PATH,
  status: "unavailable",
  config: {},
  message: "GitHub could not be asked for the repository file just now. Try again in a moment.",
};

export function createRepoFileReader(
  auth: GitHubAppAuth,
  options: { ttlMs?: number; now?: () => number } = {},
): RepoFileReader {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; state: RepoFileState }>();

  return {
    async read(target) {
      const key = `${target.repoId}:${target.defaultBranch}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.state;

      const [owner = "", repo = ""] = target.fullName.split("/");
      let state: RepoFileState;
      try {
        const client = await auth.getInstallationClient(target.githubInstallationId);
        const reading = await readRepoFile({
          client,
          repo: { owner, repo },
          ref: target.defaultBranch,
        });
        state = { path: REPO_CONFIG_PATH, ...reading };
      } catch {
        // An outage is not cached: the next visit asks again.
        return UNAVAILABLE;
      }
      cache.set(key, { at: now(), state });
      return state;
    },
  };
}
