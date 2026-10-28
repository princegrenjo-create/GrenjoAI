# MASTER PLAN — Personal AI Desk

@PlannablePlan v0.1

> **Tooling note (honest status):** the `plannable` CLI is **not installed** and the package is
> not published on the configured npm registry (`npm view plannable` → 404). The plan, the
> evidence log (`PLAN_EVIDENCE.md`) and the part state are therefore maintained **by hand** in
> the documented `@PlannablePlan v0.1` structure. Loading this file and `plannable run-next`
> are UNAVAILABLE; every other Plannable rule (one part at a time, evidence before completion,
> no unrelated edits, stop on stop conditions) is followed.

## CTX

- **Owner goal:** a personal, installable Windows desktop AI application with bring-your-own-key
  providers, automatic model discovery, manually registered custom models, advanced generation
  settings, custom agents, local-first history, and optional Supabase sync that never carries
  API keys.
- **Workspace:** `D:\MyAI` — verified empty at start (0 items, not a git repository). No Telegram
  bot or other project is present, so nothing is being repurposed or deleted.
- **Runtime:** Windows 10.0.26300, Node v24.18.0, npm 11.16.0, git 2.55, D: has ~405 GB free.
- **Stack decisions (with the evidence that forced them):**
  - Electron 44.10.0 bundles Node 24.22.1, which exposes `node:sqlite` (SQLite 3.53.4, WAL,
    foreign keys, prepared statements) — probed and confirmed in
    `.work/2026-10-29-personal-ai-desk/tmp/probe-node-sqlite.cjs`. **Therefore no native
    module is needed** and `better-sqlite3` / `electron-rebuild` / MSVC are not required.
  - TypeScript pinned to 5.9.3 because `typescript@latest` is now 7.x (the native port) and is
    not proven against this build.
  - Credentials use Electron `safeStorage` (DPAPI on Windows) through a `CredentialStore`
    interface, so no native `keytar` and no custom cryptography.
  - Renderer styling is hand-authored CSS driven by a token file (no Tailwind runtime): fewer
    build risks, and the design tokens stay reviewable in one place.
- **Non-negotiable constraints:** no API key in SQLite, exported config, logs, error text, the
  renderer, or the installer; context isolation + sandbox + restrictive CSP; user data outside
  the install directory; no fake responses; every completion claim carries command evidence.
- **Hard external dependency:** model discovery and chat calls against a live provider need the
  owner's own API key. Those become `UNAVAILABLE`-with-steps, never `PASSED`, if no key exists.
- **Safeguard basis:**
  - `basis[baseline.secrets]` — the app stores provider credentials; keys must never reach SQLite,
    renderer, export or logs.
  - `basis[input.url]` — the user supplies custom base URLs and a Supabase URL; scheme + behaviour
    must be validated as untrusted input.
  - `basis[input.boundary]` — the renderer is an untrusted boundary crossing into privileged IPC.
  - `basis[data.recovery]` — chats/settings are the only copy of the owner's work; migrations,
    backups and upgrade behaviour must not be able to lose them.
  - `basis[access.owner]` — single local user, plus a cloud account whose rows are owner-scoped by
    RLS. No multi-tenant model.
  - `basis[quality.change]` — every part must be re-verifiable by the next reader.
  - `basis[quality.ui]` — the deliverable is a desktop UI; its states and contrast are part of
    "working".

## Current contract surface (frozen — do not edit without telling the Lead)

| File | Owns |
|---|---|
| `src/shared/types.ts` | domain types |
| `src/shared/defaults.ts` | presets, parameter metadata, model hints, default settings |
| `src/shared/params.ts` | precedence resolution, capability filtering, weirdness policy, history trimming |
| `src/shared/errors.ts` | error codes, redaction, status mapping |
| `src/shared/repository-contract.ts` | `Database` / repository / sync-repository interfaces |
| `src/shared/provider-contract.ts` | `ProviderAdapter`, request specs, parsers |
| `src/shared/schemas.ts` | zod IPC validators |
| `src/shared/settings.ts` | default-fill, normalisation, patch merge |
| `src/shared/url-policy.ts` | endpoint URL + external-link policy |
| `src/shared/api.ts` | `DesktopApi` preload surface + IPC channel names |

## Parts

### PART-001 — Project foundation and shared contract

- **G:** a repository that installs, type-checks and builds the three bundles.
- **T:** git init; pin dependencies; `tsconfig.base/node/web`; three Vite configs (renderer ESM,
  main CJS, preload CJS); vitest node + jsdom configs; electron-builder config; shared contracts.
- **AC:** `npm install` completes; `npm run typecheck` exits 0 with the shared layer only;
  `npm run build` emits `dist/main/index.cjs`, `dist/preload/index.cjs`, `dist/renderer/index.html`;
  a probe run inside the Electron runtime proves `node:sqlite` works.
- **F:** `package.json`, `tsconfig.*`, `vite.*.config.ts`, `vitest.*.config.ts`,
  `electron-builder.yml`, `.gitignore`, `src/shared/**`.
- **V:** `npm run typecheck`; `npm run build`; `electron .work/.../probe-node-sqlite.cjs` →
  `ok: true`, sqlite 3.53.4.
- **State:** in progress

### PART-002 — Electron shell, window security and preload bridge

- **G:** an application window that loads the built renderer with every Electron hardening flag on,
  and a preload bridge that exposes only `DesktopApi`.
- **T:** `app.enableSandbox()`; `BrowserWindow` with `contextIsolation`, `sandbox`, `nodeIntegration:false`,
  `webviewTag:false`; CSP via header **and** meta; deny all permission requests; block navigation and
  new windows; `setWindowOpenHandler` → external HTTPS only through `shell.openExternal`; register
  `DesktopApi` through one validating IPC registrar; structured redacting logger; single-instance lock;
  graceful shutdown that closes SQLite.
- **AC:** `npm run dev` opens the window and the renderer renders without a console error; a probe
  script asserts `window.require === undefined`, `window.process === undefined`, and that a denied
  navigation does not change the URL; `npm run build` output starts under `electron dist/main/index.cjs`.
- **F:** `src/main/index.ts`, `src/main/window.ts`, `src/main/security.ts`, `src/main/logger.ts`,
  `src/main/ipc/**`, `src/preload/index.ts`, `scripts/dev.mjs`.
- **V:** dev start; packaged-app smoke script; `git grep` for the hardening flags.
- **State:** pending

### PART-003 — Local database: schema, migrations, repositories

- **G:** SQLite storage for conversations, messages, agents, providers, custom/discovered models,
  settings and sync metadata, reachable only through `Database` from the shared contract.
- **T:** `node:sqlite` connection with WAL + `foreign_keys=ON` + `busy_timeout`; versioned migration
  runner inside a transaction with a `schema_migrations` table; tables with `version`, `dirty`,
  `deleted_at`, `updated_at` for sync; monotonic per-conversation `seq`; FTS-free `LIKE` search;
  repositories implementing every interface method synchronously.
- **AC:** fresh file creates the schema and records version 1; migration re-run is a no-op; message
  `seq` is monotonic under interleaved appends in one transaction; re-opening the file preserves all
  rows; conversation search matches title and message body; soft delete hides from `list` while the
  tombstone remains for sync; every repository has a test.
- **F:** `src/main/db/**`, `tests/main/db/**`.
- **V:** `npx vitest run --config vitest.node.config.ts tests/main/db`.
- **State:** pending

### PART-004 — Provider adapters

- **G:** five adapters behind `ProviderAdapter` that build correct requests, parse streamed and
  buffered bodies, enumerate models and map failures.
- **T:** shared `fetch` executor (timeout, `redirect:'error'`, abort, bounded retry, no header
  logging); SSE framer; DeepSeek + OpenAI (Chat Completions), Gemini (`generateContent` /
  `streamGenerateContent?alt=sse`), Anthropic (Messages, `x-api-key` + `anthropic-version`, system
  as a top-level field), generic OpenAI-compatible; per-adapter parameter mapping
  (`max_tokens` vs `max_output_tokens` vs `max_tokens`; `top_p` vs `topP`; `stop` vs
  `stop_sequences`; `content.parts[].text` response shape) and capability inference.
- **AC:** each adapter's `buildChatRequest` produces the documented URL, headers and body for a
  fixture request, asserted field by field; a mocked 401/429/500/404 maps to the right code; SSE
  parsing yields the exact text deltas for a captured multi-chunk body split at awkward offsets;
  `abort` mid-stream surfaces `cancelled` and closes the reader; discovery parses each provider's
  model list shape; no adapter places a key in a URL.
- **F:** `src/main/providers/**`, `tests/main/providers/**`.
- **V:** `npx vitest run --config vitest.node.config.ts tests/main/providers`.
- **State:** pending

### PART-005 — Credential store

- **G:** OS-backed credential storage with a narrow interface and no plaintext fallback.
- **T:** `CredentialStore` interface (`get/set/delete/has/list-fingerprints`); Electron
  `safeStorage` implementation writing ciphertext to `userData/credentials.bin` with `0600`-style
  ACL intent and atomic rename; "encryption unavailable" is an explicit error state, never a
  plaintext write; `keyFingerprint = sha256(key)` first 8 hex; a memory implementation for tests.
- **AC:** round-trip of a key succeeds; the on-disk file contains no plaintext key substring;
  `isEncryptionAvailable() === false` makes `set()` throw `AppError('storage')`; delete removes the
  entry; fingerprint is stable and non-reversible.
- **F:** `src/main/credentials/**`, `tests/main/credentials/**`.
- **V:** `npx vitest run --config vitest.node.config.ts tests/main/credentials`.
- **State:** pending

### PART-006 — Chat service: precedence, streaming, cancellation, persistence

- **G:** a real chat turn — resolve settings by precedence, call the provider, stream deltas to the
  renderer, persist the assistant message, and fail visibly.
- **T:** conversation/model/agent resolution; system-prompt precedence; history trimming; offline
  detection; retry only for retryable codes; abort controller registry; persist
  `status:'streaming'` then final `complete|error|stopped`; a failed turn never leaves a
  successful-looking assistant message.
- **AC:** with a stubbed adapter, deltas arrive in order and the persisted message matches the
  concatenation; `stop()` ends with `status:'stopped'` and no `error`; a 401 leaves
  `status:'error'` with `code:'invalid_key'` and no partial text presented as complete; agent
  system prompt and parameters beat app defaults and lose to a conversation override; a
  `weirdness` value is dropped (and reported) for a model without support; duplicate `send` for the
  same conversation while one is in flight is rejected.
- **F:** `src/main/chat/**`, `tests/main/chat/**`.
- **V:** `npx vitest run --config vitest.node.config.ts tests/main/chat`.
- **State:** pending

### PART-007 — Renderer shell, design tokens, navigation

- **G:** a dark-first desktop shell with a token system, five sections and no default-styled control.
- **T:** `tokens.css` (spacing 4/8/12/16/24/32/48/64/96, type scale 12/14/16/20/25/31, radius 6/10/16,
  three elevations, semantic colour roles, re-derived dark palette); app shell with sidebar
  navigation (Chat, Agents, Models & Providers, Settings, Cloud Sync); shared primitives (Button,
  Input, Select, Textarea, Slider, Switch, Dialog, Toast, Tooltip, EmptyState, ErrorState,
  Skeleton); focus-visible ring; `aria-live` region for status.
- **AC:** every declared component renders its 8 states in tests; no `window.confirm/alert/prompt`
  anywhere; keyboard tab reaches every control with a visible ring; the screen uses ≤4 type sizes.
- **F:** `src/renderer/**` (shell, `styles/**`, `components/ui/**`), `tests/renderer/**`.
- **V:** `npx vitest run --config vitest.renderer.config.ts`; screenshot at 1440×900 + 390×844.
- **State:** pending

### PART-008 — Chat UI

- **G:** the daily-use chat screen: history sidebar with search/rename/delete, message list with
  Markdown and highlighted code, streaming display, composer with send/stop, model + agent pickers.
- **T:** conversation list with search; rename and delete through the project's dialog (not
  `confirm()`); virtual-free but disciplined list rendering; `react-markdown` + `remark-gfm` +
  `rehype-highlight` with raw HTML disabled; copy message/code actions; streaming caret; error card
  with retry; empty/loading/offline states; auto-scroll that respects user scroll-up.
- **AC:** an injected stream of deltas renders incrementally and the final text matches; a
  `{type:'error'}` event renders an error card and never a normal bubble; Enter sends and
  Shift+Enter newlines per setting; Stop is reachable and calls `chat.stop`; copy writes the exact
  message text; a `javascript:` link in model output is not rendered as a link; duplicate send is
  prevented by the disabled state.
- **F:** `src/renderer/pages/chat/**`, `src/renderer/components/chat/**`, `src/renderer/lib/**`.
- **V:** renderer vitest suites + screenshot.
- **State:** pending

### PART-009 — Providers and models UI (incl. "Others / Custom Models")

- **G:** add/edit/test/remove providers with keys; discover models; manage the visible
  **Others / Custom Models** section end to end.
- **T:** provider cards with status, fingerprint, base-URL editing, test, remove; key entry as a
  write-only field that is never echoed back; discovery with per-model capability badges and a
  refresh; custom model form (display name, exact model id, provider, endpoint override,
  description, four capabilities, limits, supported parameters, weirdness support); delete with
  confirmation; disabled controls carry the reason.
- **AC:** the key field never renders a stored value; a failed test shows the mapped message and
  keeps the form values; discovery errors are actionable; creating a custom model makes it
  selectable in the chat model picker; unsupported top-k/weirdness controls are visibly disabled
  with an explanation; a plain-HTTP non-loopback endpoint is rejected inline.
- **F:** `src/renderer/pages/providers/**`, `src/renderer/pages/models/**`.
- **V:** renderer vitest suites + screenshot.
- **State:** pending

### PART-010 — Agents UI

- **G:** create, edit, duplicate, delete agents and start a conversation bound to one.
- **T:** agent list/detail, provider+model picker, system prompt editor, per-agent parameter
  overrides, duplicate, delete with confirmation, "New chat with this agent".
- **AC:** a created agent appears in the chat agent picker and its system prompt and parameters are
  what the request carries (asserted against a stubbed API); duplicate copies every field with a
  distinct id; delete asks first and names the agent.
- **F:** `src/renderer/pages/agents/**`.
- **V:** renderer vitest suites + screenshot.
- **State:** pending

### PART-011 — Settings and advanced configuration editor

- **G:** readable settings plus a validated advanced editor with export/import.
- **T:** generation controls bound to the same parameter specs used by the request layer; per-parameter
  "not supported by this model" state; advanced key/value editor driven by a declared spec list
  (type, range, default, description, restart flag); reset-to-default per key and wholesale;
  export/import JSON that structurally cannot contain credentials; a visible statement of which
  settings need a restart.
- **AC:** every `PARAM_SPECS` entry renders a control; an out-of-range value is rejected with the
  range in the message; reset restores the documented default; export JSON contains
  `"credentials": "excluded"` and no key-shaped string; import of a tampered document reports the
  skipped keys instead of applying them; a plain-HTTP Supabase URL is refused.
- **F:** `src/renderer/pages/settings/**`.
- **V:** renderer vitest suites + `git grep` for key-shaped strings in the export path.
- **State:** pending

### PART-012 — Cloud sync UI

- **G:** optional sign-in, sync status, conflict resolution and sign-out that keeps local data.
- **T:** disabled-until-configured state, Supabase URL + anon key form (key write-only), sign-in /
  sign-up / sign-out, pending count, last synced, error surface, conflict list with keep-local /
  keep-remote, and a plain statement that API keys never sync.
- **AC:** with sync disabled the rest of the app is unaffected; sign-in failure shows the mapped
  message without a stack trace; a conflict renders both revisions and records the resolution;
  sign-out leaves the local database intact (asserted by row count before/after).
- **F:** `src/renderer/pages/sync/**`.
- **V:** renderer vitest suites + screenshot.
- **State:** pending

### PART-013 — Cloud sync engine and Supabase schema

- **G:** local-first sync with a durable outbox, version-based conflict detection and RLS-protected
  cloud tables.
- **T:** `supabase/migrations/*.sql` (tables keyed by `user_id`, `version`, `deleted_at`, `updated_at`,
  RLS enabled with owner-only policies for select/insert/update/delete); a client factory that takes
  the URL + anon key from the credential store; pull-then-push engine; exponential backoff on
  temporary failures; `applyRemote` version comparison; conflict records; sign-out keeping local data;
  a guard test that asserts no payload contains a key-shaped string.
- **AC:** RLS SQL enables RLS on every table and defines an owner policy for each of the four
  operations (asserted by parsing the SQL in a test); a duplicate remote record is `ignored`; a
  remote write with a higher version over a dirty local row produces a conflict and does not
  overwrite; a 429/503 retries with backoff and eventually records failure; offline leaves rows
  pending and resumes; no sync payload contains `sk-`/`AIza`/JWT-shaped data.
- **F:** `src/main/sync/**`, `supabase/**`, `tests/main/sync/**`.
- **V:** `npx vitest run --config vitest.node.config.ts tests/main/sync`.
- **State:** pending

### PART-014 — Packaging and installer

- **G:** a working NSIS Windows installer that launches without the dev tree.
- **T:** generated `build/icon.ico`; `npm run dist`; install into a temp profile; launch the
  installed exe; assert the window opens and `userData` is under `%APPDATA%`; reinstall over the top
  and assert the database file survives; uninstall and assert `%APPDATA%` data survives.
- **AC:** `release/Personal AI Desk-Setup-0.1.0-x64.exe` exists and is > 50 MB; the installed app
  launches and shows the shell; the smoke script reports the packaged `userData` path; a second
  install preserves rows from the first run's database.
- **F:** `electron-builder.yml`, `build/**`, `scripts/smoke-packaged.mjs`, `release/**`.
- **V:** `npm run dist`; `npm run smoke:packaged`; row-count comparison.
- **State:** pending

### PART-015 — Documentation, environment template, status

- **G:** a README that lets the owner build, install, configure providers and set up Supabase.
- **T:** README (setup, dev, test, build, install, provider setup, Supabase setup, data locations,
  update/uninstall behaviour, code signing status), `.env.example` with placeholders only,
  `docs/FEATURES.md` (implemented / limited / planned), `docs/SUPABASE.md` (schema + RLS + policies),
  `docs/THREAT-MODEL.md`, `docs/PRIVACY.md`.
- **AC:** every command in the README was executed in this workspace; `.env.example` contains no
  real value; the limitations section names live-provider testing as unverified without a key.
- **F:** `README.md`, `.env.example`, `docs/**`.
- **V:** run each documented command; `git grep` for secret-shaped strings.
- **State:** pending

### PART-016 — Audit and release gate

- **G:** an independent audit of the final state with a go/no-go.
- **T:** an auditor who did not write the code reviews the tree, runs the suites, checks the
  security invariants (CSP, sandbox, no key in SQLite/export/logs, RLS present, redirect refusal),
  and records findings with severity and evidence.
- **AC:** the audit report exists with a verdict; every release-blocking finding is either fixed and
  re-verified or explicitly recorded as an accepted limitation.
- **F:** `.work/<run>/out/audit-*.md` (sink artifact).
- **V:** the auditor's command log with exit codes.
- **State:** pending

## Status summary

| Part | Owner | State |
|---|---|---|
| PART-001 | lead | done |
| PART-002 | lead | done |
| PART-003 | db-engineer | done (audit fix applied: cross-device conflict ordering) |
| PART-004 | provider-engineer | done |
| PART-005 | lead | done |
| PART-006 | lead | done |
| PART-007 | ui-engineer | done |
| PART-008 | ui-engineer | done |
| PART-009 | ui-features | done (Lead review: 2 defects, in fix) |
| PART-010 | ui-features | done |
| PART-011 | ui-features | done (Lead review: 2 defects, in fix) |
| PART-012 | ui-features | done (Lead review: 2 defects, in fix) |
| PART-013 | sync-engineer | done (audit fix applied: request timeout + latch) |
| PART-014 | lead | done |
| PART-015 | lead | done |
| PART-016 | auditor | pass 1 complete; pass 2 pending on the final tree |

## Audit cycle log

### Pass 1 — verdict REGRESSION FOUND (no-go at that moment)

Report: `.work/2026-10-29-personal-ai-desk/out/audit-2026-10-29.md`

| Finding | Severity | Resolution |
|---|---|---|
| `applyRemote` ordered by the per-device `version` counter only, so a remote row newer by `updated_at` was dropped and the stale local row pushed over it | BLOCKER | Fixed by db-engineer: `isRemoteNewer` (version OR updated_at), newer+dirty → conflict, newer+clean → applied. Failing-first tests then green (db suite 132). |
| The packaged installer was built from older source than the audited tree | BLOCKER | Rebuilt after the last source change; the packaged smoke test re-run against the new binary. |
| A provider `baseUrl` change (UI, imported config, or a synced row) left the stored key in place, so the key followed to the new host | MAJOR | Fixed by the Lead: the key is now **bound** to the base URL it was entered for (`src/main/models/endpoint-policy.ts`); a URL change invalidates and deletes it. A custom model's `baseUrlOverride` is refused unless it is the same origin. 12 endpoint-policy tests + 12 service tests. |
| Supabase calls had no timeout and the `inFlight` latch only cleared on settle, so a stalled socket wedged sync in `syncing` forever | MAJOR | Fixed by sync-engineer: one `withTimeout` wrapper on all six client paths, latch released in `finally`, phase can never stay `syncing`, bounded retries. 6 new timeout tests. |
| The IPC trust boundary had no negative-path tests | MAJOR | Fixed by the Lead: the runner was extracted to `src/main/ipc/handler.ts` and covered by 10 tests (untrusted sender, out-of-range value, unknown key, wrong type, missing payload, preserved code, no stack leak, redaction). |
| Quit during streaming could leave `status:'streaming'` forever | MINOR | Fixed: the next launch settles any `streaming` message as `stopped`. |
| `will-navigate` allowed any `file://` URL | MINOR | Fixed: the allowed origin is now the exact renderer directory (`pathToFileURL` + trailing separator). |
| No Electron fuses; the exe is unsigned | MINOR | Fuses flipped in `scripts/after-pack.cjs` (RunAsNode off, NODE_OPTIONS off, inspect off, only-load-from-asar, embedded asar integrity, cookie encryption) and verified: with `ELECTRON_RUN_AS_NODE=1` the shipped binary still starts as an app. Signing remains documented as unavailable. |
| The repository had no commits, so there was no rollback point | MINOR | Initial commit created after the tree went green. |
| `importConfig` was not transactional | MINOR | Fixed: the whole document applies inside one `db.transaction`. |
| Settings page blanked entirely when a supporting load failed | MAJOR (Lead review) | In fix by ui-features: per-section failure handling. |
| Cloud Sync page showed only an error when the status read failed | MINOR (Lead review) | In fix by ui-features: keep the page frame and the "keys never sync" explanation. |

The auditor's own caveat was honoured: it could not test live provider calls, a live
Supabase project, install→upgrade→uninstall (it would have touched the host profile),
or the rendered UI. The Lead did all four (see `PLAN_EVIDENCE.md`).
