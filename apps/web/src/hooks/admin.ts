// Queries and mutations for settings, provider credentials and the audit view (UI-06, UI-08, PL-15).
import type { CallResult } from "@ai-pr-review/shared/api";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useApi } from "../app/api";
import { queryKeys } from "./queries";

export type RepoSettings = CallResult<"getRepoSettings">;
export type InstallationSettings = CallResult<"getInstallationSettings">;
export type CredentialInfo = CallResult<"listRepoCredentials">["items"][number];
export type AuditEntry = CallResult<"listAuditLog">["items"][number];
export type Provider = "anthropic" | "openai" | "deepseek";

/** Where settings and credentials live: one repository or one installation. */
export interface SettingsScope {
  kind: "repo" | "installation";
  id: string;
}

const settingsKey = (scope: SettingsScope) =>
  [...queryKeys.settings, scope.kind, scope.id] as const;
const credentialsKey = (scope: SettingsScope) => ["credentials", scope.kind, scope.id] as const;

export function useRepoSettings(id: string): UseQueryResult<RepoSettings> {
  const api = useApi();
  return useQuery({
    queryKey: settingsKey({ kind: "repo", id }),
    queryFn: () => api.call("getRepoSettings", { params: { id } }),
  });
}

export function useInstallationSettings(id: string): UseQueryResult<InstallationSettings> {
  const api = useApi();
  return useQuery({
    queryKey: settingsKey({ kind: "installation", id }),
    queryFn: () => api.call("getInstallationSettings", { params: { id } }),
  });
}

/** What a save sends: the changed keys (null resets one) and, for a repository, its enabled switch. */
export interface SettingsPatch {
  config?: Record<string, unknown>;
  enabled?: boolean;
}

/** Saves the dashboard layer of a repository's or an installation's settings. */
export function useSaveSettings(scope: SettingsScope) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: SettingsPatch) =>
      scope.kind === "repo"
        ? api.call("patchRepoSettings", { params: { id: scope.id }, body: input })
        : api.call("patchInstallationSettings", {
            params: { id: scope.id },
            body: { config: input.config ?? {} },
          }),
    onSuccess: (data) => {
      client.setQueryData(settingsKey(scope), data);
      void client.invalidateQueries({ queryKey: queryKeys.repos });
      void client.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

export function useCredentials(
  scope: SettingsScope,
  enabled: boolean,
): UseQueryResult<CredentialInfo[]> {
  const api = useApi();
  return useQuery({
    queryKey: credentialsKey(scope),
    enabled,
    queryFn: async () =>
      (
        await (scope.kind === "repo"
          ? api.call("listRepoCredentials", { params: { id: scope.id } })
          : api.call("listInstallationCredentials", { params: { id: scope.id } }))
      ).items,
  });
}

export function useCredentialActions(scope: SettingsScope) {
  const api = useApi();
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: credentialsKey(scope) });
  const put = useMutation({
    mutationFn: (body: { provider: Provider; api_key: string }) =>
      scope.kind === "repo"
        ? api.call("putRepoCredential", { params: { id: scope.id }, body })
        : api.call("putInstallationCredential", { params: { id: scope.id }, body }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (provider: Provider) =>
      scope.kind === "repo"
        ? api.call("deleteRepoCredential", { params: { id: scope.id }, query: { provider } })
        : api.call("deleteInstallationCredential", {
            params: { id: scope.id },
            query: { provider },
          }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: (body: { provider: Provider; api_key: string }) =>
      scope.kind === "repo"
        ? api.call("testRepoCredential", { params: { id: scope.id }, body })
        : api.call("testInstallationCredential", { params: { id: scope.id }, body }),
  });
  return { put, remove, test };
}

// ---------- platform-wide AI setting (platform administrators) ----------

export type PlatformAi = CallResult<"getPlatformAi">;
const platformAiKey = ["platform-ai"] as const;

export function usePlatformAi(enabled: boolean): UseQueryResult<PlatformAi> {
  const api = useApi();
  return useQuery({
    queryKey: platformAiKey,
    enabled,
    queryFn: () => api.call("getPlatformAi", {}),
  });
}

export function usePlatformAiActions() {
  const api = useApi();
  const client = useQueryClient();
  const onSuccess = (data: PlatformAi) => client.setQueryData(platformAiKey, data);
  const saveKey = useMutation({
    mutationFn: (body: { provider: Provider; api_key: string }) =>
      api.call("putPlatformAiCredential", { body }),
    onSuccess,
  });
  const removeKey = useMutation({
    mutationFn: (provider: Provider) =>
      api.call("deletePlatformAiCredential", { query: { provider } }),
    onSuccess,
  });
  /** Activates a provider and/or saves models. */
  const patch = useMutation({
    mutationFn: (body: { active_provider?: Provider | null; models?: Record<string, string> }) =>
      api.call("patchPlatformAi", { body }),
    onSuccess,
  });
  return { saveKey, removeKey, patch };
}

// ---------- audit ----------

export interface AuditPage {
  items: AuditEntry[];
  next: string | null;
}

export function useAuditList(
  installationId: string,
  action: string,
): UseInfiniteQueryResult<InfiniteData<AuditPage, string | undefined>> {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ["audit", installationId, action] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<AuditPage> => {
      const page = await api.call("listAuditLog", {
        params: { id: installationId },
        query: {
          ...(action ? { action } : {}),
          limit: 50,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      });
      return { items: page.items, next: page.next_cursor };
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });
}
