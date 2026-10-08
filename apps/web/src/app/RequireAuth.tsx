import { useRef } from "react";
import { Navigate, useLocation } from "react-router";
import { ErrorState, LoadingState } from "../components/States";
import { useMe } from "../hooks/queries";
import { AppLayout } from "./AppLayout";

export interface LoginRedirectState {
  /** Where to go after signing in. */
  from?: string;
  /** The user was signed in a moment ago: say the session ended instead of just asking to sign in. */
  expired?: boolean;
}

/**
 * Everything but the login page sits behind this. No session sends the user to /login (and back to the page
 * they wanted afterwards); a session that ends while the app is open does the same with a message.
 */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  const wasSignedIn = useRef(false);

  if (me.isPending) return <LoadingState label="Checking your session…" />;
  if (me.isError) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <ErrorState
          error={me.error}
          onRetry={() => void me.refetch()}
          title="Cannot reach the server"
        />
      </div>
    );
  }
  if (!me.data) {
    const state: LoginRedirectState = {
      from: `${location.pathname}${location.search}`,
      expired: wasSignedIn.current,
    };
    return <Navigate to="/login" replace state={state} />;
  }
  wasSignedIn.current = true;
  return <AppLayout me={me.data} />;
}
