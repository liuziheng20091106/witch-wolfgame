# Repository Guidelines

## Project Overview

魔女狼人杀 is a React/TypeScript browser social-deduction game for configurable 6–14-player games. It supports deterministic seeds, localStorage persistence, spectator or human-player mode, AI decisions, a deterministic local fallback, multiplayer rooms, and an installable offline-capable PWA (`README.md`, `public/manifest.webmanifest`).

Optional services are a public main backend, private provider proxy, and standalone multiplayer server. The main backend validates and rate-limits browser requests, the proxy uses TLS 1.3 mTLS plus HMAC and manages provider retries/fallback, and multiplayer uses WebSockets (`server/main.mjs`, `proxy/server.mjs`, `multiplayer/server.ts`).

## Architecture & Data Flow

- `src/main.tsx` restores theme state and mounts `src/app/App.tsx`.
- `App` selects setup/game surfaces, composes local or multiplayer state, mounts settings/PWA UI, and lazy-loads large views (`src/app/App.tsx`).
- `src/app/useGameController.ts` owns durable React state, local persistence, lifecycle, callbacks, and AI automation. Local games flow through `createGame` → `reduceGame` → `selectObservation` → feature views (`src/domain/engine/createGame.ts`, `src/domain/engine/reducer.ts`, `src/domain/engine/selectors.ts`).
- State transitions are reducer/engine-owned and event-driven. `pendingDecision` is the command boundary: validate its ID, actor, phase, and legal candidates before accepting human or asynchronous AI results. Never mutate `GameState` in UI code.
- `selectObservation` is the privacy boundary. Player views must not expose hidden roles, private events, unexposed knowledge, secret votes, or actual forged-speech authors; spectator/ended/post-game views may be omniscient (`src/domain/engine/selectors.ts`).
- AI flows `prompts.ts` → `client.ts` → `schemas.ts`. Prompts receive scoped observations; the client validates endpoints, versions, sessions, timeout/retry/cancellation; Zod validates model decisions. `fallback.ts` uses the seeded RNG/reducer path.
- Multiplayer uses `protocol.ts` and `useMultiplayerRoom.ts`: queue the initial connection message, persist resume tokens, consume room snapshots, and submit only the observed pending decision.
- Persist committed state through `src/storage/browserStorage.ts`, which validates versioned settings/setup/game/history/session data and migrations. History is deduplicated by `gameId` and bounded.
- Service flow is browser → `server/main.mjs` → mTLS/HMAC `proxy/server.mjs` → provider. Custom-provider traffic is browser-direct; main also upgrades `/multiplayer`.

Invariants:

- Rules support 6–14 seats: 2–4 wolves, one seer, one witch, and remaining villagers. Keep roster, role, character, skill, and entity links valid (`src/domain/engine/createGame.ts`, `src/storage/gameStateSchema.ts`).
- Thread seeded `rngState` through game logic. Use Web Crypto only for explicitly random seed generation; never use `Math.random()` in game logic (`src/domain/engine/random.ts`).
- Keep versions synchronized across `package.json`, the Vite fallback, and backend/proxy `acceptedClientVersions` (`README.md`, `vite.config.ts`, `server/main.config.example.json`, `proxy/proxy.config.example.json`).
- Preserve request keys, `AbortController`, timeouts, disposal guards, and pending-decision checks for async AI work (`src/app/useGameController.ts`, `src/ai/client.ts`).
- Storage migration policy: **do not write migrations for old localStorage data**. Protocol/structure changes may extend zod schemas with optional fields only; when legacy saves become incompatible, the required remediation is to ensure users can delete the old save (a clear/corrupt-data path) rather than migrating it in code.

## Key Directories

- `src/app/`: composition, controller, theme/PWA, clipboard, download, and export adapters.
- `src/domain/`: model, catalogs/data, deterministic engine, events, selectors, and skills.
- `src/ai/`: provider types, prompts, client, schemas, fallback, diagnostics, and lore helpers.
- `src/features/setup/`, `src/features/game/`, `src/features/settings/`: controlled React surfaces; local CSS Modules sit beside components.
- `src/storage/`: persistence, migrations, and Zod schemas.
- `src/multiplayer/`: browser WebSocket protocol and room hook.
- `shared/`: browser/Node contracts, especially `gamePromptContract.js`.
- `server/`: public validation, CORS, rate/concurrency limits, proxy orchestration, and updates.
- `proxy/`: private mTLS provider proxy, provider/config files, and updates.
- `multiplayer/`: standalone room server and persistent room handling.
- `scripts/`: smoke tests, simulations, certificate generation, provider tools, and operational helpers.
- `public/`: manifest and icons. `dist/` is generated and ignored.

## Development Commands

Node.js 22+ and npm are required. Use the committed lockfile:

```bash
npm ci
npm run dev                    # Vite, normally 127.0.0.1:5173
npm run build                  # tsc -b then vite build
npm run preview
npm run server:multiplayer    # normally 127.0.0.1:34024
npm run server:local-ai       # normally 127.0.0.1:34025
npm run server:proxy
npm run server:main
```

Useful checks:

```bash
npm run test:domain            # knowledge + voting
npm run test:backend           # offline main/proxy integration
npm run test:multiplayer       # offline WebSocket integration
npm run test:update             # offline updater/rollback
npm run test:storage
npm run test:ai-guidance
npm run sim -- --games 1000    # relative Monte Carlo signal, not pass/fail
py -m unittest scripts/test_verify_provider.py
```

`npm run certs:generate` requires OpenSSL and mutates certificate files; use it only for local backend setup or smoke tests. `compose.yaml` is the current integrated Node 22 deployment; the split `compose.main.yaml` and `compose.proxy.yaml` use legacy `./app/...` mounts, omit multiplayer, and should not be treated as canonical without inspection (`compose.yaml`, `compose.main.yaml`, `compose.proxy.yaml`).

## Code Conventions & Common Patterns

- Strict TypeScript: ES modules, named exports, single quotes, semicolons, two-space indentation, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` (`tsconfig.json`, `src/**/*.ts`).
- Centralize domain types in `src/domain/model.ts`; use discriminated unions. Import shared protocol/catalog contracts from `shared/gamePromptContract.js` where applicable.
- Validate all external, provider, WebSocket, config, and localStorage data with Zod before trusting it. Keep AI errors, invalid decisions, storage failures, and corrupted-history errors distinct (`src/ai/schemas.ts`, `src/multiplayer/protocol.ts`, `src/storage/`).
- Keep engine logic pure/deterministic. Add rules as reducer/engine transitions and structured events, not React conditionals.
- Components are controlled: pass narrow typed callbacks; keep transient form state in features and durable state in the controller/domain.
- Use named PascalCase components/types, camelCase functions/locals, and UPPER_SNAKE_CASE storage keys/constants. Phase/role/skill discriminants are lowercase hyphenated strings.
- Browser-native APIs are preferred for localStorage, Web Crypto, WebSocket, service workers, `AbortController`, `structuredClone`, clipboard/download, media queries, and resize observation.
- Reuse global CSS tokens/themes and CSS Modules; retain focus-visible accessibility and `prefers-reduced-motion` behavior (`src/styles/global.css`).
- Backend config is JSON plus environment-variable names. Never put API keys, passwords, certificate contents, or private update material in source or logs.

## Important Files

- `package.json`: version, scripts, dependencies; command authority.
- `vite.config.ts`, `tsconfig.json`: build, relative base, service-worker generation, injected app version, and strict compiler settings.
- `src/main.tsx`, `src/app/App.tsx`, `src/app/useGameController.ts`: browser bootstrap and orchestration.
- `src/domain/model.ts`, `src/domain/engine/createGame.ts`, `reducer.ts`, `selectors.ts`, `random.ts`: authoritative state, initialization, transitions, privacy projection, and determinism.
- `src/ai/client.ts`, `prompts.ts`, `schemas.ts`: provider boundary and legal decision contract.
- `src/storage/browserStorage.ts`, `gameStateSchema.ts`: persistence and invariants.
- `src/multiplayer/protocol.ts`, `useMultiplayerRoom.ts`: WebSocket boundary.
- `server/gameProtocol.mjs`, `server/main.mjs`, `proxy/server.mjs`: protocol validation and service routing.
- `server/main.config.example.json`, `proxy/proxy.config.example.json`, `proxy/providers.example.json`: canonical config shapes; secrets belong in environment files.
- `compose.yaml`: preferred integrated deployment. `README.md`: operational runbook. `CHANGELOG.md`: user-visible history, not command authority.

## Runtime/Tooling Preferences

- Use Node.js 22+ and npm; do not substitute Bun for project scripts. CI pins Node 22 and runs `npm ci` plus `npm run build` (`.github/workflows/release.yml`).
- No package-manager version field, `.nvmrc`, or `.node-version` is committed; the lockfile is npm lockfileVersion 3.
- Browser code assumes modern `fetch`, `AbortController`, `structuredClone`, Web Crypto, `matchMedia`, `ResizeObserver`, `localStorage`, and WebSocket.
- Python is optional and used for the zero-dependency Tkinter provider verifier and its stdlib unit tests. OpenSSL is needed for certificate generation/backend smoke setup; `OPENSSL_BIN` can override discovery on Windows.
- Frontend envs are `VITE_MAIN_BACKEND_ENDPOINT` and `VITE_MULTIPLAYER_ENDPOINT`. Local AI reads `OMP_AI_CONFIG_FILE` or `OMP_AI_BASE_URL`, `OMP_AI_API_KEY`, and `OMP_AI_MODEL` (`src/vite-env.d.ts`, `scripts/local-ai-proxy.mjs`).
- Treat `.env`, deployment env files, `certs/`, provider keys, update passwords, mTLS keys, and `.runtime/` state as sensitive. Preserve live config/certificates; do not log secrets.

## Testing & QA

- QA is script-driven, not framework-driven: `.mjs` smokes use Vite SSR with Node `assert/strict` or local checks; Python uses stdlib `unittest`. There is no Jest/Vitest/Playwright/Cypress dependency, lint command, formatter command, coverage command, or coverage threshold (`package.json`, `scripts/`).
- Offline domain/storage/AI/roleplay/voting checks include `knowledge-fact-smoke.mjs`, `verify-voting.mjs`, `browser-storage-smoke.mjs`, `ai-debug-report-smoke.mjs`, `verify-ai-decision-guidance.mjs`, `roleplay-resource-smoke.mjs`, and `configurable-roster-smoke.mjs`.
- `test:backend`, `test:multiplayer`, and `test:update` isolate dependencies with localhost fixtures, temporary directories, subprocesses, WebSockets, or generated certificates and clean up afterward. They cover protocol/security, reconnects, retries/fallback, SSE, rollback, locks, and restart signaling.
- `test:visual-evidence` writes JSON under `.runtime/ai-evidence`; it is not browser automation. For UI changes, run `npm run dev` and exercise desktop/mobile surfaces in a real browser after animations/theme settle.
- `test:ai-live`, `scripts/live-ai-integration-smoke.mjs`, and `scripts/verify_provider.py` can make real network requests and consume provider quota. Run only intentionally with credentials; never expose keys in logs or artifacts.
- `npm run sim` runs deterministic local fallback games (default 200) and reports relative outcome changes; it is not a pass/fail balance test.
- Several `scripts/verify-*.mjs` feature checks are not npm aliases, including voice mimic, vision, levitation, creature, ignition, last words, post-game, and clairvoyance. Run them directly only when the affected behavior requires it.
- Add focused regression coverage for changed observable contracts and failure boundaries. Avoid tests of source text or incidental implementation details.

Operational documentation contains stale references to `scripts/quick_update.py` and `certs/update-pass.txt`; verify those files before using the update instructions. `deploy.main.env.example` and `deploy.proxy.env.example` do exist but are ignored only after copied deployment env files are created. `package.json` is the executable command authority; `README.md` is the operational runbook but is not infallible.
