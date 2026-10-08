// SYSTEM MODULE: the only unscoped queries over tenant tables (design §9, phase 2).
//
// For the worker, the webhook handler and scheduled jobs, which act on behalf of the platform and not of
// a signed-in user. Dashboard and REST code must use the tenant-scoped functions from the package root
// instead; eslint.config.mjs restricts who may import this module.
export * from "./installations";
export * from "./webhooks";
export * from "./users";
export * from "./runs";
export * from "./credentials";
export * from "./sessions";
export * from "./repositories";
export * from "./retention";
export * from "./workerRuns";
export * from "./lifecycle";
export * from "./operations";
export * from "./platform";
