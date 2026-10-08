import { Link } from "react-router";
import { EmptyState } from "../components/States";
import { useMe } from "../hooks/queries";
import { useDocumentTitle } from "../lib/useDocumentTitle";

export function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <EmptyState
      title="Page not found"
      action={
        <Link className="btn" to="/repos">
          Go to repositories
        </Link>
      }
    >
      The page you are looking for does not exist.
    </EmptyState>
  );
}

export function AccountPage() {
  useDocumentTitle("Account");
  const me = useMe();
  const data = me.data;
  if (!data) return null;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Account</h1>
      <section aria-labelledby="account-user" className="card p-4">
        <h2 id="account-user" className="mb-2 text-base font-semibold">
          Signed in as
        </h2>
        <p className="text-sm">{data.user.login}</p>
      </section>
      <section aria-labelledby="account-installs" className="card p-4">
        <h2 id="account-installs" className="mb-2 text-base font-semibold">
          Installations
        </h2>
        {data.installations.length === 0 ? (
          <p className="text-muted text-sm">
            The GitHub App is not installed on anything you can access.{" "}
            <a href={data.install_url} target="_blank" rel="noopener noreferrer">
              Install it
              <span className="sr-only"> (opens GitHub in a new tab)</span>
            </a>
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.installations.map((installation) => (
              <li key={installation.id}>
                {installation.account_login}{" "}
                <span className="text-muted">
                  ({installation.account_type}, {installation.role})
                </span>
                {" · "}
                <Link className="underline" to={`/installations/${installation.id}/settings`}>
                  Defaults and usage
                </Link>
                {installation.role === "admin" ? (
                  <>
                    {" · "}
                    <Link className="underline" to={`/installations/${installation.id}/audit`}>
                      Audit log
                    </Link>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
