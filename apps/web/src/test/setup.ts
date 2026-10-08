// Runs before every dashboard test file (jsdom has no matchMedia, ResizeObserver or pointer capture, which the
// theme code and the dropdown menu use). Also owns the mock API server: a test that triggers a request nobody
// described fails instead of silently reaching the network.
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./server";

// `findBy*` and `waitFor` give up after one second by default, which is too short when the whole suite runs at once
// on a busy machine (the failure then looks like a broken screen). A test that is really broken still fails, a little later.
configure({ asyncUtilTimeout: 4000 });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});
afterAll(() => server.close());

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;
