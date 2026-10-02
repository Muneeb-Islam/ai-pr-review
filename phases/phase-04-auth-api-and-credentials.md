# Phase 4 – Auth, API Foundation & Credentials

**Depends on:** Phases 2, 3  
**Unblocks:** Phases 10, 14  
**Refs:** PL-09, PL-10, PL-12, PL-13, PL-15, AC-17, AC-18, design §8, §9

## Goal

Users sign in with GitHub and can only reach their own data. Repository settings and provider keys can be managed securely through the API.

## Tasks

### Authentication (PL-12)
- [ ] GitHub OAuth through the App: `/auth/github/login` (state parameter, PKCE if supported), `/auth/github/callback`, `/auth/logout`.
- [ ] Server-side sessions in PostgreSQL; cookie `HttpOnly; Secure; SameSite=Lax`; idle and absolute timeouts; session rotation on login.
- [ ] CSRF protection for all mutating requests (token header tied to the session).
- [ ] The user's GitHub token is used only to list their installations and repo permissions; do not persist it unless refresh is required (if stored, encrypt it).
- [ ] `GET /api/me` returns the user, accessible installations and the App install URL.

### Authorisation (PL-13)
- [ ] Resolve a user's accessible installations and repositories from GitHub, cache in `user_installations` with a short TTL; refresh on demand and on login.
- [ ] Roles: **viewer** (access through the installation) and **admin** (GitHub admin on the repo, or org owner). Middleware `requireRepoAccess(role)`.
- [ ] Every route uses the tenant-scoped data layer from Phase 2. Cross-tenant requests return 404 (no existence leak).

### Settings API (PL-09)
- [ ] `GET/PATCH /api/repos/:id/settings` validated with the shared zod schemas; admin only to write; reject unknown keys; return effective config and which keys come from the repo file (read-only indicator, filled in by Phase 5).
- [ ] Enable/disable a repository.
- [ ] Validate `base_url`: HTTPS only, reject loopback, private, link-local and metadata addresses, including after DNS resolution.
- [ ] Per-installation settings for defaults (quota values are read-only for now).

### Provider credentials (PL-10)
- [ ] `PUT/DELETE /api/repos/:id/credentials` and `/api/installations/:id/credentials`: **write-only**; responses show provider, last four characters and timestamps only.
- [ ] Envelope encryption: AES-256-GCM, random data key per record wrapped with `ENCRYPTION_KEY`, `key_version` stored; a rotation script re-wraps keys.
- [ ] `getDecryptedCredential(repoId)` exists only in a worker-side module, resolving repo credential then installation credential.
- [ ] Optional "test connection" endpoint that makes a minimal provider call and returns success or a sanitised error.

### API foundation
- [ ] Consistent error envelope, request IDs, input validation, rate limiting per user and per IP.
- [ ] OpenAPI document generated from zod schemas; typed client generation for the web app.
- [ ] Audit log writes for settings changes, credential set/delete, and later re-run/cancel (PL-15).
- [ ] Security headers and CORS restricted to the web origin.

## Testing

- OAuth flow with a mocked GitHub: login, callback with bad state, logout, session expiry.
- Authorisation matrix for every endpoint: anonymous, wrong tenant, viewer, admin (AC-17).
- Credential endpoints never return the key (response, logs, error messages); ciphertext differs for equal inputs; rotation works (AC-18).
- `base_url` validation rejects `http://`, `localhost`, `169.254.169.254`, private ranges, and hostnames that resolve to them.
- CSRF: mutation without a token fails.

## Deliverables

- Auth, authorisation middleware, settings and credential endpoints, OpenAPI spec, audit log.

## Exit criteria

- AC-17 and AC-18 pass at the API level.
- A developer can sign in locally, see only their sandbox repo, set a DeepSeek key and update settings.

## Risks

- Role mapping from GitHub is the most security-sensitive part. Keep it small, cached briefly and fully tested.
- Storing the user's OAuth token expands blast radius; avoid it if possible.
