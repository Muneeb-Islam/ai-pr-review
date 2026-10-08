import { useApi } from "../app/api";
import type { Me } from "../hooks/queries";
import { ExternalIcon, GitHubMark } from "./icons";

/**
 * UI-01: signed in, but the GitHub App is not installed on anything the user can see. The access list is read
 * when signing in, so after installing the app the user signs in again to pick the new installation up.
 */
export function Onboarding({ me }: { me: Me }) {
  const api = useApi();
  return (
    <section aria-labelledby="onboarding-title" className="card mx-auto max-w-xl p-8">
      <h1 id="onboarding-title" className="text-xl font-semibold">
        Install the GitHub App to get started
      </h1>
      <p className="text-muted mt-2 text-sm">
        You are signed in as <strong className="text-fg">{me.user.login}</strong>, but the AI PR
        Review app is not installed on any account or organization you can access yet. Install it on
        the repositories you want reviewed. Nothing is reviewed until you do.
      </p>
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm">
        <li>Install the app and choose the repositories.</li>
        <li>Come back here and sign in again so your new repositories show up.</li>
      </ol>
      <div className="mt-6 flex flex-wrap gap-3">
        <a
          className="btn btn-primary"
          href={me.install_url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <GitHubMark />
          Install the GitHub App
          <ExternalIcon />
        </a>
        <a className="btn" href={api.loginUrl("/repos")}>
          I have installed it: sign in again
        </a>
      </div>
    </section>
  );
}
