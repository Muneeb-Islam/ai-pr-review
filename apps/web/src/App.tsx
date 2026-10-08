import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@ai-pr-review/shared/api";
import { useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { ApiContext, defaultApi } from "./app/api";
import { createQueryClient } from "./app/queryClient";
import { RequireAuth } from "./app/RequireAuth";
import { LoginPage } from "./pages/LoginPage";
import { AccountPage, NotFoundPage } from "./pages/OtherPages";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { AuditPage } from "./pages/AuditPage";
import { FindingDetailPage } from "./pages/FindingDetailPage";
import { FindingsPage } from "./pages/FindingsPage";
import { InstallationSettingsPage } from "./pages/InstallationSettingsPage";
import { PlatformAiPage } from "./pages/PlatformAiPage";
import { PullHistoryPage } from "./pages/PullHistoryPage";
import { RepoSettingsPage } from "./pages/RepoSettingsPage";
import { ReposPage } from "./pages/ReposPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunsPage } from "./pages/RunsPage";

/** The routes of the dashboard (design §15). The router itself is supplied by main.tsx (or by a test). */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route index element={<Navigate to="/repos" replace />} />
        <Route path="/repos" element={<ReposPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunDetailPage />} />
        <Route path="/repos/:id/settings" element={<RepoSettingsPage />} />
        <Route path="/repos/:repoId/pulls/:number" element={<PullHistoryPage />} />
        <Route path="/findings" element={<FindingsPage />} />
        <Route path="/findings/:id" element={<FindingDetailPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/installations/:id/settings" element={<InstallationSettingsPage />} />
        <Route path="/installations/:id/audit" element={<AuditPage />} />
        <Route path="/platform/ai" element={<PlatformAiPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

/** Providers every screen needs: the API client and the query cache. Tests pass their own. */
export function AppProviders({
  children,
  api = defaultApi,
  queryClient,
}: {
  children: ReactNode;
  api?: ApiClient;
  queryClient?: QueryClient;
}) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  return (
    <ApiContext.Provider value={api}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ApiContext.Provider>
  );
}
