# Feature status

Last verified: 2026-10-29. Nothing here is marked **DONE** unless a command in
[PLAN_EVIDENCE.md](../PLAN_EVIDENCE.md) produced the result, or the packaged
application was launched and observed.

Legend: **DONE** — implemented and verified. **PARTIAL** — implemented, but some
behaviour could not be verified in this workspace. **UNAVAILABLE** — needs a
credential, account or certificate that does not exist here; the steps to finish it
are recorded. **NOT BUILT** — deliberately out of this release.

---

## Application

| Feature | Status | Evidence / limit |
|---|---|---|
| Electron shell, single instance, hardened window | **DONE** | `npm run build`; packaged smoke: `window.require === undefined`, CSP meta present |
| Renderer sandbox / context isolation / no Node | **DONE** | smoke probe 9/9 checks |
| Restrictive CSP (`default-src 'none'`, `connect-src 'none'`) | **DONE** | header in `src/main/security.ts`, meta tag in the built HTML |
| Permissions, navigation, new windows, webview all denied | **DONE** | `src/main/security.ts`, `src/main/window.ts`; navigation is pinned to the exact renderer directory, not the whole `file://` scheme |
| Electron fuses flipped in the shipped binary | **DONE** | `scripts/after-pack.cjs`; with `ELECTRON_RUN_AS_NODE=1` the packaged exe still starts as an app (probe in `PLAN_EVIDENCE.md`) |
| Windows installer (NSIS, per-user) | **DONE** | `release/Personal AI Desk-Setup-0.1.0-x64.exe`, 124,081,924 bytes |
| Install / launch / upgrade / uninstall lifecycle | **DONE** | install exit 0 → 9/9 smoke checks → reinstall exit 0 with data intact → uninstall exit 0, install dir removed, `%APPDATA%` data preserved |
| Desktop + Start-menu shortcuts | **DONE** | observed after install |
| User data separate from install directory | **DONE** | `%APPDATA%\Personal AI Desk`; smoke asserts it is outside the install dir |
| Code signing | **UNAVAILABLE** | no certificate; signing skipped by electron-builder |

## Data

| Feature | Status | Evidence / limit |
|---|---|---|
| SQLite via `node:sqlite` (no native module) | **DONE** | runtime probe: SQLite 3.53.4, WAL, FKs |
| Versioned migrations, idempotent re-run | **DONE** | `tests/main/db/schema.test.ts` |
| Conversations, messages, agents, models, providers, settings, sync outbox | **DONE** | 127 persistence tests |
| Monotonic per-conversation message order | **DONE** | `tests/main/db/messages.test.ts` incl. interleaved appends |
| Conversation search (title + message body) | **DONE** | `tests/main/db/conversations.test.ts` |
| Full-text search | **NOT BUILT** | `LIKE '%term%'`; fine at personal scale, no FTS index |
| Soft delete with tombstones for sync | **DONE** | `tests/main/db/conversations.test.ts` |

## Providers and models

| Feature | Status | Evidence / limit |
|---|---|---|
| Five adapters behind one interface | **DONE** | 164 provider tests, request shapes asserted field by field |
| Key in exactly one header, never in a URL or body | **DONE** | `tests/main/providers/security.test.ts` |
| No redirect following | **DONE** | `redirect: 'error'`; transport tests |
| SSE streaming incl. chunk-boundary robustness | **DONE** | `tests/main/providers/sse.test.ts` (1-byte chunking) |
| Error mapping (401/404/400/413/429/5xx) | **DONE** | `tests/main/providers/*.test.ts` |
| Cancellation | **DONE** | abort tests; chat service `stop()` test |
| Automatic model discovery | **DONE** for parsing; **PARTIAL** live | discover request/parse tested per provider; first page only, no live call |
| Manual custom models ("Others / Custom Models") | **DONE** | custom model persistence tests |
| Capability flags | **PARTIAL** | every flag is a *hint* (`catalog-hint` or name heuristic), never a verified fact — stated in the UI |
| `Live provider call end-to-end` | **UNAVAILABLE** | no API key in this workspace; use *Test connection* + one message after adding your key |

## Generation controls

| Feature | Status | Evidence / limit |
|---|---|---|
| temperature, top-p, top-k, frequency/presence penalty, max tokens, stop, seed, reasoning effort | **DONE** | `tests/node/shared.test.ts` precedence + suppression |
| Provider-specific parameter mapping | **DONE** | each adapter's body asserted |
| Unsupported parameters disabled with a reason, never silently sent | **DONE** | `resolveGenerationParams` suppressed map |
| Max output tokens capped at the model's documented limit | **DONE** | clamping test |
| Weirdness forwarded only where the model declares support | **DONE** | native vs suppressed tests |
| Labelled application-level creativity bias | **DONE** | bias test asserts temperature/top-p shift and the explanation text |
| Precedence: model default → app → agent → conversation | **DONE** | precedence test |

## Chat

| Feature | Status | Evidence / limit |
|---|---|---|
| Streaming display, stop, retry | **DONE** | chat service + renderer streaming tests |
| Errors never rendered as a successful reply | **DONE** | error-path test asserts `status:'error'` and no normal bubble |
| Markdown + highlighted code, raw HTML disabled | **DONE** | renderer markdown tests; `javascript:` link not followed |
| Copy message / copy code | **DONE** | renderer copy test |
| Auto-title from first message | **DONE** | chat service test |
| History trimming to a token budget | **DONE** | trim + max-history tests |
| Duplicate submission prevention | **DONE** | concurrent-send test |
| Offline detection | **DONE** | `blockRequestsWhenOffline` path; renderer offline state |

## Agents

| Feature | Status | Evidence / limit |
|---|---|---|
| Create / edit / duplicate / delete | **DONE** | agent CRUD tests |
| Agent model, system prompt, parameters applied to a request | **DONE** | chat precedence test |
| Start a conversation bound to an agent | **DONE** | renderer test |
| Tool execution / autonomy | **NOT BUILT** | deliberate: agents are personas, no shell or tool access |

## Settings

| Feature | Status | Evidence / limit |
|---|---|---|
| Readable settings + advanced editor with per-key reset | **DONE** | renderer settings tests |
| Range validation with the range in the message | **DONE** | normalisation + renderer tests |
| Export non-secret configuration | **DONE** | `credentials: "excluded"`, refuses a key-shaped document |
| Import with applied/skipped/warnings | **DONE** | import tests |
| Restart-required indicators | **PARTIAL** | no setting currently requires a restart; the hook exists but is unproven |
| Unrestricted raw environment editor | **NOT BUILT** | deliberately absent: settings are typed app configuration, not OS env |

## Credentials

| Feature | Status | Evidence / limit |
|---|---|---|
| OS credential store (DPAPI via `safeStorage`) | **DONE** | `secureStorageAvailable: true` in the packaged app; 9 credential tests |
| Key never in SQLite, export, logs, renderer, installer | **DONE** | schema has no key column; redaction tests; export allowlist; gate rule |
| A key is only sent to the origin it was entered for | **DONE** | `src/main/models/endpoint-policy.ts`: the key is bound to the provider base URL and is deleted when that URL changes; a model endpoint override on another origin is refused. 12 endpoint-policy tests |
| Refuses to write plaintext when the store is unavailable | **DONE** | unavailable-backend test |
| Fingerprint instead of display | **DONE** | sha256 prefix test |
| Session JWT storage | **DONE** | credential-store-backed adapter; no localStorage |
| Structured error codes reach the renderer | **DONE** | `contextBridge` keeps only a thrown value's `message` (proved by a probe), so the code travels as a `code: sentence` prefix and `asAppError` decodes it; retryability is derived from the code. 5 encoding tests + a bridge probe |

## Cloud sync

| Feature | Status | Evidence / limit |
|---|---|---|
| Local-first pull/push engine with a durable outbox | **DONE** | 80 sync tests |
| Version conflict detection, never a silent overwrite | **DONE** | conflict tests |
| Bounded retry with exponential backoff + jitter | **DONE** | retry tests |
| Serialized `syncNow`, offline mode, sign-out keeps local data | **DONE** | offline / serialization tests |
| Cloud schema + RLS (6 tables, 24 owner policies, enable+force) | **DONE** (SQL only) | `tests/main/sync/rls-sql.test.ts` parses the SQL |
| No credential in any pushed payload | **DONE** | every pushed payload scanned for `/sk-|AIza|eyJ/` |
| `service_role` absent from the tree | **DONE** | security-scan test + gate rule |
| **Sync against a real Supabase project** | **UNAVAILABLE** | no project exists here; steps in [supabase/README.md](../supabase/README.md) |
| Conflict UI shows both revisions | **PARTIAL** | the UI can show revisions and the summary; the remote *body* is not exposed by `SyncConflict`, so it cannot be previewed side by side |
| Cross-cycle backoff growth | **PARTIAL** | `SyncPendingRow` does not expose `attempts`, so a retry after a cycle restarts at the base delay instead of escalating |

## Testing

| Area | Suites | Tests |
|---|---|---|
| Persistence + migrations | 11 | 132 |
| Providers | 12 | 164 |
| Chat orchestration + SQLite integration | 2 | 14 |
| Credentials | 1 | 9 |
| Settings / provider / model services + endpoint policy | 4 | 44 |
| IPC message runner | 1 | 10 |
| Sync + RLS + timeouts | 12 | 86 |
| Shared contract (params, URL policy, errors, settings, encoding) | 1 | 28 |
| **Node total** | **42 files** | **477** |
| Renderer (primitives, dialog, chat, shell, four feature pages) | **12 files** | **132** |

Both suites run with `npm test`. The node suite needs no network and no credentials;
the renderer suite runs under jsdom against a fake `DesktopApi`.

### Bundle size

| Artifact | Raw | Gzip |
|---|---|---|
| `dist/renderer` JS | 700.30 kB | 212.75 kB |
| `dist/renderer` CSS | 62.15 kB | 9.41 kB |
| `dist/main/index.cjs` | 1,190.78 kB | 240.52 kB |
| `dist/preload/index.cjs` | 5.26 kB | 1.50 kB |

The renderer exceeds the 200 kB gzip guideline by ~13 kB, almost entirely
`highlight.js` via `rehype-highlight`. It is a local-file load, not a network
fetch, so it does not affect start time on this platform; if it matters, restrict
the highlighter to a language subset or lazy-load it. Recorded rather than hidden.

## Audit status

An independent auditor (a teammate that wrote none of this code) ran two passes.

| Pass | Verdict | Report |
|---|---|---|
| 1 | `REGRESSION FOUND` — 2 blockers, 3 majors, 5 minors | `.work/2026-10-29-personal-ai-desk/out/audit-2026-10-29.md` |
| 2 (final) | `VERIFIED WITH CAVEATS` — **GO for owner hand-off, with conditions**. No blocker, no major | `.work/2026-10-29-personal-ai-desk/out/audit-2026-10-29-pass2.md` |

The audited artifact is commit `06142c3` and installer
`sha256 7223DEC3…81DA38`. The auditor verified the build is not older than the
source, read the fuse wire back out of the shipped exe, confirmed `app.asar`
contains no source, test, sink, `.env`, credential or SQLite file, and re-ran every
suite (including under a shifted timezone) with identical results.

### Conditions on the hand-off (owner actions, not defects)

1. No live provider call has ever been made. Your first real acceptance is: add a
   key → *Test connection* → send one message.
2. No live Supabase project exists. Keep sync off until `0001_init.sql` and
   `0002_rls.sql` have run in your project, then watch the first two-device sync.
3. The installer is unsigned, so SmartScreen warns on first run.
4. Any further edit needs a rebuild and a new hash; the certification covers
   `06142c3` and that installer hash only.

### Accepted residual risks (auditor pass 2)

| Residual | Impact | Why accepted |
|---|---|---|
| The sync engine's test double still compares `version` only, while production also compares `updated_at` | Test-adequacy smell; the real rule is guarded by 5 cases in `tests/main/db/sync.test.ts`, and the auditor re-proved it 9/9 against the real repository | Test-only; changing it would move the certified commit for no shipped benefit |
| The startup repair of a `streaming` message does not bump `version`/`dirty`, and a `streaming` status pulled from another device is applied verbatim | A repaired or remotely-streaming message shows as stopped locally until the next launch / is not re-uploaded | Cosmetic; no data loss |
| A per-error `retryable: false` is lost across the IPC bridge (the code survives, retryability is re-derived from the code table) | Only the Retry affordance can be offered where it would fail again | The code table is right for every built-in code |
| `npm audit` reports dev-only advisories (vitest/tinypool) | None shipped: `npm audit --omit=dev` is 0 | Dev toolchain only; upgrade when convenient |
| A key is bound to the exact base URL including its path, so editing the path requires re-entering the key | Deliberate friction on a config edit | Safer than inferring which path changes are "the same destination" |

## Deliberately not in this release
- Subscriptions, payments, a public marketplace, multi-tenant SaaS.
- Local model execution (llama.cpp / Ollama hosting inside the app).
- Agent tool execution, shell access, multi-agent orchestration.
- A web or mobile client — the architecture is prepared for them (shared contracts, platform-agnostic
  provider adapters, a credential-store interface), but they are not built.
- Code signing.

---

## Installer details

| Field | Value |
|---|---|
| File | `release/Personal AI Desk-Setup-0.1.0-x64.exe` |
| Size | 124,229,063 bytes |
| SHA-256 | `7223DEC30286CC3427185E27D2D69A84A78F6145CDCCA41B637FFE88AD81DA38` |
| Target | NSIS, x64, per-user, non-one-click |
| Install dir | `%LOCALAPPDATA%\Programs\Personal AI Desk` (changeable during setup) |
| Electron fuses | Run-As-Node off, NODE_OPTIONS off, CLI inspect off, only-load-from-asar, asar integrity, cookie encryption |
| Signed | No — SmartScreen will warn |
| Verified cycle | install (exit 0, shortcuts created) → installed-exe smoke 9/9 → data preserved → uninstall (exit 0, program gone, `%APPDATA%` intact) |
