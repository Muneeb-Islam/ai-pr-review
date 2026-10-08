import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router";
import { useApi } from "../app/api";
import type { Me } from "../hooks/queries";

const ITEM =
  "flex w-full cursor-pointer items-center rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2";

export function AccountMenu({ me }: { me: Me }) {
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  async function signOut() {
    try {
      await api.call("logout");
    } finally {
      // Whatever the answer: nothing of this session should stay on screen.
      queryClient.clear();
      navigate("/login", { replace: true });
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="btn" aria-label={`Account menu for ${me.user.login}`}>
        {me.user.avatar_url ? (
          <img
            src={me.user.avatar_url}
            alt=""
            width={20}
            height={20}
            referrerPolicy="no-referrer"
            className="h-5 w-5 rounded-full"
          />
        ) : null}
        <span className="max-w-32 truncate">{me.user.login}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="card z-20 min-w-44 p-1 shadow-lg"
        >
          <DropdownMenu.Label className="text-muted px-3 py-1.5 text-xs">
            Signed in as {me.user.login}
          </DropdownMenu.Label>
          <DropdownMenu.Item asChild>
            <Link to="/account" className={`${ITEM} no-underline`}>
              Account
            </Link>
          </DropdownMenu.Item>
          {me.platform_admin ? (
            <DropdownMenu.Item asChild>
              <Link to="/platform/ai" className={`${ITEM} no-underline`}>
                Global AI setting
              </Link>
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item
            className={ITEM}
            onSelect={() => {
              // Access is read from GitHub only at sign-in; repeating it picks up new repositories and
              // permissions. GitHub redirects straight back (already authorised), so no sign-out is needed.
              window.location.assign(api.loginUrl(location.pathname + location.search));
            }}
          >
            Refresh GitHub access
          </DropdownMenu.Item>
          <DropdownMenu.Item className={ITEM} onSelect={() => void signOut()}>
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
