import { setupServer } from "msw/node";

/** The mock API. Tests add handlers with `server.use(...)`; each test starts from none. */
export const server = setupServer();
