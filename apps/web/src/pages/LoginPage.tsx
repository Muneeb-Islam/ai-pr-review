import { Navigate, useLocation, useSearchParams } from "react-router";
import { useApi } from "../app/api";
import type { LoginRedirectState } from "../app/RequireAuth";
import { GitHubMark } from "../components/icons";
import { LoadingState } from "../components/States";
import { useMe } from "../hooks/queries";
import { useDocumentTitle } from "../lib/useDocumentTitle";

/** What the api's sign-in callback reports in `?error=` (apps/api/src/routes/auth.ts), in plain words. */
const ERRORS: Record<string, string> = {
  access_denied: "GitHub did not give access, so you were not signed in.",
  invalid_state: "The sign-in took too long or came from another window. Please try again.",
  invalid_code: "GitHub rejected the sign-in code. Please try again.",
  github_unavailable: "GitHub could not be reached. Please try again in a moment.",
};

/** Only a path on this site: one leading slash, never a full URL (an open redirect). */
const safePath = (value: string | undefined): string =>
  value && value.startsWith("/") && !value.startsWith("//") ? value : "/repos";

export function LoginPage() {
  useDocumentTitle("Sign in");
  const api = useApi();
  const me = useMe();
  const location = useLocation();
  const [params] = useSearchParams();
  const state = (location.state ?? {}) as LoginRedirectState;
  const returnTo = safePath(state.from ?? params.get("return_to") ?? undefined);
  const errorCode = params.get("error");

  if (me.isPending) return <LoadingState label="Checking your session…" />;
  if (me.data) return <Navigate to={returnTo} replace />;

  const message = errorCode
    ? (ERRORS[errorCode] ?? "Sign-in failed. Please try again.")
    : state.expired
      ? "Your session ended. Sign in again to continue."
      : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <section aria-labelledby="login-title" className="card w-full max-w-md p-8 text-center">
        <h1 id="login-title" className="text-2xl font-bold">
          AI PR Review
        </h1>
        <p className="text-muted mt-2 text-sm">
          Automated pull request reviews with a dashboard for every run. Sign in with the GitHub
          account that has access to your repositories.
        </p>
        {message ? (
          <p
            role={errorCode ? "alert" : "status"}
            className="bg-surface-2 mt-4 rounded p-3 text-left text-sm"
          >
            {message}
          </p>
        ) : null}
        <a className="btn btn-primary mt-6 w-full" href={api.loginUrl(returnTo)}>
          <GitHubMark />
          Sign in with GitHub
        </a>
        <p className="text-muted mt-4 text-xs">
          We read which repositories you can access. Your GitHub token is not stored.
        </p>
      </section>
    </main>
  );
}
