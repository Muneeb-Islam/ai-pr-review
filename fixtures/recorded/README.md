# Recorded real-provider runs

What a real model answered to the repository's fixture pull requests (`packages/core/src/agents/codeReview/fixtures.ts` and `security/fixtures.ts`), one JSON file per fixture, kept as regression fixtures for prompt and validator changes. See `packages/core/src/agents/recordings.ts`.

**There are no recordings yet.** They need a real provider key, which only the owner has: run

```bash
RECORD=1 PROVIDER=deepseek MODEL=<model> PROVIDER_API_KEY=... npm run review:fixtures
RECORD=1 AGENT=security PROVIDER=deepseek MODEL=<model> PROVIDER_API_KEY=... npm run review:fixtures
```

and commit the files it writes here (`<agent>/<provider>-<model>/<fixture>.json`). A recording holds the model's JSON answers about the fixture code and a hash of each request. It holds no key and no user data.

`npm test` replays every recording through the current engine and checks the outcome is the recorded one. When a prompt changes, the recorded requests no longer match: the recording is _stale_. Stale recordings still test everything after the model; to test the prompt, record again, compare the outcomes (`docs/pilot.md`, "Tuning"), and commit the new files. `RECORDINGS_MUST_BE_FRESH=1 npm test` fails on a stale recording; run it before a release.
