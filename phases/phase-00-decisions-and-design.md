# Phase 0 – Decisions & Design

**Depends on:** nothing  
**Unblocks:** all phases  
**Status:** documents written; owner review pending

## Goal

Agree scope, decisions and architecture so later phases do not re-litigate them.

## Deliverables (written)

- [docs/scope.md](../docs/scope.md) — what we build, non-goals, requirements `PL-xx`/`UI-xx`, acceptance criteria `AC-13`–`AC-23`.
- [docs/design.md](../docs/design.md) — architecture, data model, API, security model, run lifecycle, engine interfaces.
- [docs/decision-log.md](../docs/decision-log.md) — decisions 1–23.
- [docs/PRD-v0.1.md](../docs/PRD-v0.1.md) — original review requirements, still the source for `FR-xx`.

## Remaining tasks

- [ ] Owner reviews and confirms the **assumed** decisions: 15 (stack), 16 (bring-your-own key), 17 (no billing), 18 (Docker Compose), 19 (coverage from Actions artifacts), 20 (fork policy), 21 (retention), 22 (config precedence).
- [ ] Owner reviews `docs/design.md` §5 (data model), §8 (API) and §10 (engine interfaces); later phases build on them.
- [ ] Decide the product/repo name (placeholder `ai-pr-review-assistant`; keep it in one place).
- [ ] Decide whether the existing GitHub repository stays the home of the monorepo (recommended: yes, keep history).
- [ ] Decide the production hosting target, or defer it to Phase 15.

## Exit criteria

- Owner sign-off on scope, assumed decisions and design.
- No open question blocks Phases 1–4.

## Risks

- Scope is much larger than the original Action. Mitigation: engine first, dashboard second, strict non-goals.
