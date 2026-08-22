# Repository Guidelines

## Project Overview

魔女狼人杀 is a six-player React/TypeScript social-deduction game. Games run in the browser, persist to `localStorage`, support deterministic seeds and either spectator or human-player mode, and use an OpenAI-compatible model or deterministic local fallback for non-human decisions.

The optional backend is a two-tier Node.js service: the public main server validates/rate-limits client requests, then calls a private provider proxy over TLS 1.3 mTLS plus HMAC. The proxy applies provider retries, key rotation, timeouts, streaming aggregation, and fixed-order fallback.

## Architecture & Data Flow

- `src/main.tsx` initializes the saved/system theme and renders `src/app/App.tsx`.
- `App` switches between `SetupView` and `GameView`, applies theme/judgment-mode behavior, and mounts `AiSettingsDrawer`.
- `src/app/useGameController.ts` is the application orchestration boundary. It loads browser state, owns React state, persists games/history, advances turns, starts/cancels AI requests, and exposes callback props to views.
- New games flow through `src/domain/engine/createGame.ts`. State transitions must flow through the pure reducer in `src/domain/engine/reducer.ts`; do not mutate `GameState` directly in UI/controller code.
- `src/domain/engine/selectors.ts` converts private `GameState` into a viewer-safe `GameObservation`. Preserve its privacy boundary: players must not receive hidden roles, private events, or actual forged-speech authors.
- AI decisions flow through `src/ai/prompts.ts` -> `src/ai/client.ts` -> `src/ai/schemas.ts`. Responses are Zod-validated against the current pending decision and legal candidates. `src/ai/fallback.ts` provides deterministic local behavior.
- Every committed state is saved through `src/storage/browserStorage.ts`; completed games are deduplicated by `gameId` and capped at 50 history entries.
- Free-provider traffic flows browser -> `server/main.mjs` -> mTLS/HMAC proxy -> `proxy/server.mjs` -> configured provider. Custom-provider traffic is browser-direct.

Important invariants:

- The board is fixed at six seats: wolves x2, seer x1, witch x1, villagers x2.
- Seeded RNG must remain deterministic; avoid `Math.random()` in game logic.
- Validate `pendingDecision.id` and actor before accepting asynchronous results.
- Keep client version, `package.json`, and backend/proxy `acceptedClientVersions` synchronized.

## Key Directories

- `src/app/`: app composition, controller, theme resolution, clipboard helpers.
- `src/domain/`: central model, catalogs, pure game engine, skill registry and implementations.
- `src/ai/`: provider types, prompt construction, HTTP client, response schemas, local fallback.
- `src/features/`: controlled React views; each feature keeps its `.module.css` beside the component.
- `src/storage/`: versioned Zod schemas and browser persistence.
- `server/`: public validation/rate-limit/orchestration backend.
- `proxy/`: private provider pool, update endpoint, provider/config examples.
- `scripts/`: smoke tests, simulations, certificate generation, provider verification, and deployment helpers.

## Development Commands

```bash
npm install                 # install locked npm dependencies
npm run dev                 # Vite development server
npm run build               # strict TypeScript build + production Vite bundle
npm run preview             # serve the production bundle locally
npm run test:domain         # domain/knowledge regression smoke
npm run test:backend        # isolated main/proxy integration smoke
npm run test:update         # isolated updater/rollback smoke
npm run sim -- --games 1000 # deterministic Monte Carlo regression signal
```

Backend development:

```bash
npm run certs:generate
npm run server:proxy
npm run server:main
```

`certs:generate` mutates ignored certificate files and requires OpenSSL; do not use it as routine validation. There is no configured lint, formatter, or coverage command. Use `npm run build` and `git diff --check` for normal source validation.

## Code Conventions & Common Patterns

- TypeScript is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ES modules, single quotes, semicolons, and two-space indentation.
- Use discriminated unions and Zod at external/storage boundaries. Parse before trusting provider responses, config files, or `localStorage` data.
- Keep domain logic pure and deterministic. Add transitions/events in the engine; do not special-case game rules in React components.
- Components are controlled by typed props and callbacks. Local hooks are for presentation state; durable/game state belongs in `useGameController` or `GameState`.
- Async AI work uses `AbortController`, request keys, disposed/stale guards, and pending-decision IDs. Preserve cancellation and stale-result protection when changing request flow.
- Keep error channels distinct: AI request errors, invalid decisions, storage failures, and corrupted history have separate user-visible handling.
- Use `crypto.getRandomValues`/`randomUUID`, not weak randomness, for seeds and session IDs.
- Reuse CSS variables from `src/styles/global.css`; use CSS Modules for feature styles and honor `prefers-reduced-motion`.
- Backends use JSON config plus environment-variable names for dependency injection. Never place API keys, passwords, or certificate contents in source or logs.

## Important Files

- `package.json`: version, npm scripts, runtime dependencies.
- `vite.config.ts`: relative static base, React plugin, polling watcher, `__APP_VERSION__` injection.
- `src/domain/model.ts`: authoritative game types, phases, roles, events, decisions.
- `src/domain/engine/reducer.ts`: authoritative state-transition entry point.
- `src/domain/engine/selectors.ts`: privacy-filtered observations.
- `src/app/useGameController.ts`: browser/application orchestration.
- `src/ai/client.ts`: retries, timeouts, endpoint validation, free/custom routing.
- `src/ai/schemas.ts`: legal AI response contracts.
- `src/storage/browserStorage.ts`: storage keys, migrations, schemas, history limits.
- `server/gameProtocol.mjs`: backend request/prompt protocol validation.
- `server/main.config.example.json`, `proxy/proxy.config.example.json`, `proxy/providers.example.json`: canonical config shapes.
- `compose.yaml`: preferred combined deployment; older split compose files may be stale.
- `README.md`: authoritative Chinese operational runbook.
- `CHANGELOG.md`: Keep-a-Changelog-style user-visible changes.

## Runtime/Tooling Preferences

- Required application runtime: Node.js 22 or newer, npm, and the committed `package-lock.json`. Do not substitute Bun for project scripts.
- Browser code assumes modern `fetch`, `AbortController`, `structuredClone`, Web Crypto, `matchMedia`, `ResizeObserver`, and `localStorage`.
- Python is optional for `scripts/verify_provider.py` and `scripts/quick_update.py`; the verifier uses Tkinter and standard-library unittest.
- Docker deployment uses official `node:22-alpine` images via `compose.yaml`.
- OpenSSL is required only for certificate generation/backend smoke setup; `OPENSSL_BIN` can override discovery on Windows.
- Treat `.env`, `deploy.*.env`, `certs/`, provider keys, update passwords, and mTLS private keys as secrets. Preserve live config and certificates during deployment.

## Testing & QA

- `npm run test:domain` checks deterministic knowledge IDs, soul exchange, information spread, and duplicate-ID rejection.
- `npm run test:backend` is an offline integration smoke using local upstreams/temp certificates. It covers protocol validation, mTLS/HMAC/replay defense, rate limits, SSE/non-stream responses, retries, timeouts, fixed provider fallback, and structured logs.
- `npm run test:update` is offline and covers auth, redirects, retries, atomic replacement, backup/rollback/recovery, locks, health checks, and restart signaling.
- Provider verifier unit tests: `py -m unittest scripts/test_verify_provider.py`. Launching `py scripts\verify_provider.py` can make real provider requests and consume quota.
- `npm run sim` is not a pass/fail test; use relative outcome changes as a regression signal because it runs the local fallback, not real AI.
- No automated browser suite or coverage threshold exists. For UI changes, run `npm run dev`, exercise the affected desktop and mobile surfaces in a real browser, and capture screenshots after theme/animation state settles.
- Add focused regression coverage for changed observable contracts. Avoid tests that assert source text or incidental implementation details.
- Do not casually run `scripts/quick_update.py`, certificate generation, or real provider checks; they have deployment, secret, quota, or filesystem side effects.
