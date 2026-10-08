import type { FastifyInstance } from "fastify";
import { registerEndpoint, type Handlers, type Platform } from "../http/platform";
import { analyticsHandlers } from "./analytics";
import { authHandlers } from "./auth";
import { auditHandlers } from "./auditLog";
import { credentialHandlers } from "./credentials";
import { eventHandlers } from "./events";
import { exportHandlers } from "./export";
import { findingsHandlers } from "./findings";
import { repoHandlers } from "./repos";
import { runHandlers } from "./runs";
import { settingsHandlers } from "./settings";

/** Every endpoint of the contract has exactly one handler: the type makes a missing one a compile error. */
export const handlers: Handlers = {
  ...authHandlers,
  ...repoHandlers,
  ...runHandlers,
  ...eventHandlers,
  ...settingsHandlers,
  ...credentialHandlers,
  ...findingsHandlers,
  ...analyticsHandlers,
  ...auditHandlers,
  ...exportHandlers,
};

export function registerRoutes(app: FastifyInstance, platform: Platform): void {
  for (const name of Object.keys(handlers) as Array<keyof Handlers>) {
    // The handler type depends on the endpoint name; the registrar re-checks everything at runtime.
    registerEndpoint(app, name, handlers[name] as never, platform);
  }
}
