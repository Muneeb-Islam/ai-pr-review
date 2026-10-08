// PL-14 on the client: an update on the event stream refreshes what is on screen, and when the stream drops
// the dashboard falls back to polling and recovers by itself.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ApiContext } from "../app/api";
import { API, makeRepo, makeRun } from "../test/fixtures";
import { asEventSource, FakeEventSource } from "../test/fakeEventSource";
import { json, renderApp, signedInAs, testApi } from "../test/render";
import { server } from "../test/server";
import { queryKeys } from "./queries";
import { useRunEvents, type LiveStatus } from "./useRunEvents";

beforeEach(() => FakeEventSource.reset());
afterEach(() => vi.unstubAllGlobals());

function setup(options: Parameters<typeof useRunEvents>[0] = {}) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiContext.Provider value={testApi()}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ApiContext.Provider>
  );
  const hook = renderHook(() => useRunEvents({ eventSource: asEventSource, ...options }), {
    wrapper,
  });
  const keysInvalidated = () =>
    invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
  return { ...hook, queryClient, invalidate, keysInvalidated };
}

const updated = {
  run_id: "run-1",
  repo_id: "repo-1",
  status: "running",
  at: "2026-10-05T10:00:00.000Z",
};

describe("useRunEvents", () => {
  it("opens the stream with the session cookie and reports it live once connected", () => {
    const { result } = setup();
    expect(FakeEventSource.last.url).toBe(`${API}/api/events`);
    expect(FakeEventSource.last.init).toEqual({ withCredentials: true });
    expect(result.current).toBe<LiveStatus>("connecting");
    act(() => FakeEventSource.last.open());
    expect(result.current).toBe("live");
  });

  it("refreshes the lists, the run and the repositories when a run changes", () => {
    const { keysInvalidated } = setup();
    act(() => FakeEventSource.last.open());
    act(() => FakeEventSource.last.message("run.updated", updated));
    expect(keysInvalidated()).toEqual(
      expect.arrayContaining([
        JSON.stringify(queryKeys.runs),
        JSON.stringify(queryKeys.run("run-1")),
        JSON.stringify(queryKeys.repos),
      ]),
    );
  });

  it("ignores messages that are not valid run updates", () => {
    const { invalidate } = setup();
    act(() => FakeEventSource.last.open());
    act(() => FakeEventSource.last.message("run.updated", "not json"));
    act(() => FakeEventSource.last.message("run.updated", { run_id: "x" }));
    act(() => FakeEventSource.last.message("run.updated", { ...updated, status: "exploded" }));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("falls back to polling when the connection drops, and stops when it is back", async () => {
    const { result, invalidate } = setup({ pollMs: 20 });
    act(() => FakeEventSource.last.open());
    expect(result.current).toBe("live");

    act(() => FakeEventSource.last.fail());
    expect(result.current).toBe("polling");
    await waitFor(() => expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(6)); // two rounds of three

    // The browser reconnects: live again, one catch-up refresh, then no more polling.
    act(() => FakeEventSource.last.open());
    expect(result.current).toBe("live");
    await new Promise((r) => setTimeout(r, 30));
    const settled = invalidate.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(invalidate.mock.calls.length).toBe(settled);
  });

  it("polls from the start if the stream never opens", async () => {
    const { result, invalidate } = setup({ pollMs: 20 });
    act(() => FakeEventSource.last.fail());
    expect(result.current).toBe("polling");
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });

  it("opens a new connection when the browser gave up, and checks the session meanwhile", async () => {
    const { keysInvalidated } = setup({ pollMs: 1_000, reconnectMs: 20 });
    const first = FakeEventSource.last;
    act(() => first.fail(true));
    expect(keysInvalidated()).toContain(JSON.stringify(queryKeys.me));
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    expect(FakeEventSource.last).not.toBe(first);
  });

  it("asks who the user is when the server says the session ended", () => {
    const { keysInvalidated } = setup();
    const source = FakeEventSource.last;
    act(() => source.open());
    act(() => source.message("session.expired", {}));
    expect(source.closed).toBe(true);
    expect(keysInvalidated()).toContain(JSON.stringify(queryKeys.me));
  });

  it("closes the stream and stops polling when the app unmounts", async () => {
    const { unmount, invalidate } = setup({ pollMs: 20 });
    const source = FakeEventSource.last;
    act(() => source.fail());
    unmount();
    expect(source.closed).toBe(true);
    const calls = invalidate.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(invalidate.mock.calls.length).toBe(calls);
  });

  it("does nothing when disabled", () => {
    setup({ enabled: false });
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

describe("live updates on screen", () => {
  it("a run changes status in the list without a page refresh (AC-16)", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    signedInAs();
    let status: "queued" | "running" = "queued";
    server.use(
      http.get(`${API}/api/repos`, () => json({ items: [makeRepo({ id: "repo-1" })] })),
      http.get(`${API}/api/runs`, () => {
        const run = makeRun({
          id: "run-1",
          status,
          started_at: status === "running" ? new Date().toISOString() : null,
          finished_at: null,
        });
        return json({ items: [run], next_cursor: null });
      }),
    );
    renderApp("/runs");

    const row = await screen.findByRole("list", { name: "Runs in progress" });
    expect(row).toHaveTextContent("Queued");
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    act(() => FakeEventSource.last.open());
    expect(await screen.findByText("Live")).toBeVisible();

    status = "running";
    act(() => FakeEventSource.last.message("run.updated", updated));
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Runs in progress" })).toHaveTextContent("Running"),
    );
    expect(screen.getByRole("list", { name: "Runs in progress" })).not.toHaveTextContent("Queued");
  });

  it("says so on screen when the live connection is down", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    signedInAs();
    server.use(http.get(`${API}/api/repos`, () => json({ items: [makeRepo({ id: "repo-1" })] })));
    renderApp("/repos");
    await screen.findByRole("list", { name: "Repositories" });
    act(() => FakeEventSource.last.fail());
    expect(await screen.findByText(/refreshing every few seconds/i)).toBeVisible();
    act(() => FakeEventSource.last.open());
    expect(await screen.findByText("Live")).toBeVisible();
  });
});
