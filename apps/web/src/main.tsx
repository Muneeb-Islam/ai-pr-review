import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { AppProviders, AppRoutes } from "./App";
import { initTheme } from "./lib/theme";
import "./styles.css";

// Set the theme before the first render so there is no flash of the wrong one. This is a module script, not an
// inline one, so it works under a strict Content-Security-Policy.
initTheme();

// A data router (not <BrowserRouter>) so a page with unsaved changes can block navigation (`useBlocker`).
// The one splat route hands every path to <AppRoutes>, which owns the route table.
const router = createBrowserRouter([{ path: "*", element: <AppRoutes /> }]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
