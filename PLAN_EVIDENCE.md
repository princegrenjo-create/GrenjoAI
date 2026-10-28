# PLAN EVIDENCE — Personal AI Desk

One row per verified claim. **PASSED** means the command ran in this workspace and
produced the quoted result. **IMPLEMENTED** means code exists but was not executed.
**UNAVAILABLE** means a precondition was missing (credential, account, certificate)
and the steps to finish it are recorded instead.

Run sink: `.work/2026-10-29-personal-ai-desk/` (gitignored).
Audit report: `.work/2026-10-29-personal-ai-desk/out/audit-2026-10-29.md`.

## Environment

| Fact | Value | How |
|---|---|---|
| Workspace | `D:\MyAI`, empty at start (0 entries, not a git repo) | `Get-ChildItem -Force -Recurse \| Measure-Object` → `0`; `git status` → `fatal: not a git repository` |
| Node / npm | v24.18.0 / 11.16.0 | `node -v`, `npm -v` |
| Electron | 44.10.0 (Node 24.22.1, Chromium 152) | runtime probe |
| SQLite engine | `node:sqlite`, SQLite 3.53.4 | probe, see PART-001 #1 |
| OS | Windows 10.0.26300, x64 | `[System.Environment]::OSVersion.VersionString` |

---

## PART-001 — Foundation

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `node:sqlite` works inside Electron, so **no native module** is needed | **PASSED** | `electron .work/…/tmp/probe-node-sqlite.cjs` → `{"ok":true,"sqliteVersion":"3.53.4","journal_mode":"wal","reopened":"v","foreignKeysOn":true}` |
| 2 | Dependencies install; the Electron binary is present | **PASSED** | `npm install` → `added 539 packages in 45s`; npm 11 blocked the Electron postinstall, so `node node_modules/electron/install.js` → `electron.exe now present: 245775872` |
| 3 | Toolchain resolves | **PASSED** | `npx tsc --version` → `5.9.3`; `npx vite --version` → `vite/7.3.7 win32-x64 node-v24.18.0` |
| 4 | Three bundles build | **PASSED** | `npm run build` → `dist/main/index.cjs 393.62 kB`, `dist/preload/index.cjs 5.25 kB`, `dist/renderer` JS + CSS, exit 0 |

## PART-002 — Shell, security, preload

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | The built app launches, preload bridge works, React mounts, CSP present | **PASSED** | `electron . --smoke-test` → `apiType=object hasChatSend=true requireType=undefined processType=undefined rootChildren=1 cspPresent=true ok=true` |
| 2 | Renderer has no Node, no `process`, no remote access | **PASSED** | same probe, packaged and dev |
| 3 | `userData` is outside the install directory and under the profile AppData | **PASSED** | packaged smoke, 9/9 checks |

## PART-003 — Database

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Schema, migrations, idempotent re-run, reopen durability, `seq` monotonic under interleaved appends, search, soft delete, every repository, settings normalisation, applyRemote | **PASSED** | `npx vitest run --config vitest.node.config.ts tests/main/db` → **10 files, 132 tests passed** |
| 2 | The providers table holds no key material | **PASSED** | exact 15-column assertion + a value scan after a fingerprint is written |
| 3 | Cross-device conflicts are decided on version **or** updated_at (audit BLOCKER fix) | **PASSED** | 5 new tests; failing-first run showed `expected 'ignored' to be 'conflict'`, fixed run 132/132 |

## PART-004 — Providers

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Five adapters, request shape asserted field by field, SSE chunk-boundary robustness, error mapping, discovery parsing, cancellation | **PASSED** | `npx vitest run … tests/main/providers` → **12 files, 164 tests passed** |
| 2 | The key appears in exactly one header, never in a URL or body, never in an error | **PASSED** | `tests/main/providers/security.test.ts` |
| 3 | `redirect: 'error'` on every request | **PASSED** | transport tests |
| 4 | Live acceptance of each request shape | **UNAVAILABLE** | no API key exists here and inventing one is forbidden; use *Test connection* after adding a key |

## PART-005 — Credentials

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | DPAPI-backed round-trip, delete, fingerprint, corrupt-file recovery, unavailable-store refusal | **PASSED** | `npx vitest run … tests/main/credentials` → 9 tests |
| 2 | The ciphertext file contains no plaintext key | **PASSED** | test asserts the raw file lacks the secret and its prefix |
| 3 | The packaged app reports the OS store available | **PASSED** | packaged smoke → `secureStorageAvailable: true` |
| 4 | A key is bound to the base URL it was entered for | **PASSED** | 12 endpoint-policy tests + 12 provider/model service tests |

## PART-006 — Chat

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Streaming order, persistence, stop, error-never-success, precedence, weirdness policy, duplicate send, missing key, unknown model, auto-title, history trim | **PASSED** | `npx vitest run … tests/main/chat` → **14 tests** (11 unit + 3 against the real SQLite database) |
| 2 | A turn persists through a close/reopen (an app restart) | **PASSED** | `tests/main/chat/integration.test.ts` — `openDatabase`, send, settle, checkpoint, close, reopen, assert rows |
| 3 | Prior turns are replayed as context with the right roles | **PASSED** | same file, `turns` assertion |

## PART-007 / 008 — Renderer foundation + chat UI

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Primitives, dialog focus contract, chat streaming/error/copy, sidebar search/rename/delete, composer Enter rules, eight provider-error cards, app shell routing | **PASSED** | `npx vitest run --config vitest.renderer.config.ts` → 84 tests at that point (suite has since grown) |
| 2 | Visual bar, no horizontal scroll at 390 px, 44×44 tap targets, focus-visible ring | **PASSED** | 7 screenshots in `.work/2026-10-29-ui-screenshot/raw/`, probes recorded by the author; Lead re-inspected `chat-dark-1440x900.png` and `chat-dark-390x844.png` |
| 3 | Real IPC end-to-end from the renderer | **PASSED** (separately) | the packaged smoke asserts `window.api` and `chat.send` exist in the shipped bundle |

## PART-009 / 010 / 011 / 012 — Feature pages

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Providers/models (incl. "Others / Custom Models"), agents, settings, sync pages; 46 new tests | **PASSED** | renderer suite (see the final counts below) |
| 2 | Every page renders at 1440×900 without horizontal overflow; titles and `<h1>` are correct per route | **PASSED** | Lead's offscreen capture: `overflow: 0` on all four routes; images in `.work/2026-10-29-personal-ai-desk/out/ui/` |
| 3 | Settings survives a failing supporting load (audit finding) | **IN FIX** | recorded as a defect by the Lead's capture; fix + test in progress |
| 4 | Sync page keeps its explanation when the status read fails | **IN FIX** | same |

## PART-013 — Sync

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Local-first engine, conflict gate, offline, serialization, backoff, payload sanitisation, RLS SQL guard | **PASSED** | `npx vitest run … tests/main/sync` → **12 files, 86 tests passed** |
| 2 | A stalled Supabase call cannot wedge the engine (audit MAJOR fix) | **PASSED** | 6 timeout tests: phase `error`, `lastError.code='timeout'`, latch clears, healthy second `syncNow` completes |
| 3 | RLS cannot silently disappear | **PASSED** | `rls-sql.test.ts` — 6 tables, enable+force, 4 policies each, `auth.uid() = user_id` in every USING/WITH CHECK |
| 4 | No credential in any pushed payload | **PASSED** | every pushed payload scanned for `/sk-|AIza|eyJ/` |
| 5 | Sync against a real Supabase project | **UNAVAILABLE** | no project or key exists here; steps in `supabase/README.md` |

## PART-014 — Installer

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | NSIS installer builds | **PASSED** | `npm run dist` → `release/Personal AI Desk-Setup-0.1.0-x64.exe` (see the SHA in `docs/FEATURES.md`) |
| 2 | Silent install succeeds and creates shortcuts | **PASSED** | `/S` → exit 0; installed to `%LOCALAPPDATA%\Programs\Personal AI Desk`; Start-menu + desktop `.lnk` present |
| 3 | The installed app launches and passes the self-check | **PASSED** | `node scripts/smoke-packaged.mjs --exe=<installed>` → 9/9 |
| 4 | Upgrade preserves data | **PASSED** | reinstalled over the top → exit 0; marker row and all 10 tables still present; app relaunched 9/9 |
| 5 | Uninstall removes the program and keeps user data | **PASSED** | uninstaller `/S` → exit 0; install dir and shortcuts gone; `%APPDATA%\Personal AI Desk\data\app.db` intact with the marker row |
| 6 | Electron fuses are flipped in the shipped binary | **PASSED** | afterPack log `before={…49,48,49,49,48,48,48,49,49} after={…48,49,48,48,49,49,48,49,49}`; with `ELECTRON_RUN_AS_NODE=1` the exe still ran as an app (`ok=True apiType=object`) |
| 7 | Code signing | **UNAVAILABLE** | no certificate; electron-builder logged `no code signing certificate configured, signing is skipped` |
| 8 | The **final** installer installs, launches and preserves data | **PASSED** | `release/Personal AI Desk-Setup-0.1.0-x64.exe` (124,229,063 bytes, sha256 `7223DEC3…81DA38`): `/S` → exit 0; Start-menu + desktop shortcuts `True`; installed exe smoke 9/9; marker row and all 10 tables still present before and after launch |

## Cross-cutting fix — error codes across the contextBridge

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | A custom property on a thrown value does **not** survive `contextBridge` | **PASSED** (finding) | `.work/…/tmp/apperror-probe.cjs`: an `Error` with `appError`, a plain object with `appError`, and a flattened plain object all arrived as `Error` with `keys: []` and no code |
| 2 | A `code: sentence` message marker **does** survive, so the code can be recovered | **PASSED** | `.work/…/tmp/apperror-probe2.cjs` → `{"message":"missing_key: No API key is stored for DeepSeek."}` in the renderer; `out/apperror-probe2.json` |
| 3 | The renderer decodes it, and retryability is derived from the code | **PASSED** | 5 new tests in `tests/node/shared.test.ts` (round-trip, retryability derivation, no false positives, redaction still applied) |

## PART-015 — Documentation

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | README documents install, dev, test, build, providers, sync, data locations, limitations | **PASSED** | every command in it was executed in this workspace |
| 2 | `.env.example` holds placeholders only | **PASSED** | reviewed; no real value |
| 3 | Threat model committed | **PASSED** | `docs/THREAT-MODEL.md` |
| 4 | Feature status with honest PARTIAL/UNAVAILABLE labels | **PASSED** | `docs/FEATURES.md` |

## Quality gates

| Gate | Result |
|---|---|
| `npx tsc -p tsconfig.node.json --noEmit` | exit 0 |
| `npx tsc -p tsconfig.web.json --noEmit` | exit 0 |
| `npx vitest run --config vitest.node.config.ts` | 42 files / **477 tests passed** |
| `npx vitest run --config vitest.renderer.config.ts` | 12 files / **132 tests passed** |
| `node scripts/quality-gate.mjs` | 0 blocking, 3 allowed (`service_role` named in its own refusal guard) |
| `npm audit --omit=dev` | 0 vulnerabilities (info/low/moderate/high/critical all 0) |
| `node scripts/smoke-packaged.mjs` | 9/9 checks against the unpacked build **and** against the installed exe |
| `npm run dist` | exit 0; fuses flipped; NSIS installer produced |
| Renderer screenshot pass | 18 captures + 4 Lead captures, all routes `overflowX: 0` at 1440×900 and 390×844 |

## Explicitly not verified

| Item | Why | How to finish it |
|---|---|---|
| A real message to each provider | no API key in this workspace | add a key in Models & Providers → *Test connection* → send one message |
| Cloud sync against a real project | no Supabase project | run `supabase/migrations/*.sql`, paste the URL + anon key, sign in |
| Signed installer | no certificate | purchase a code-signing certificate; set `CSC_LINK`/`CSC_KEY_PASSWORD` and rebuild |
| Two-device sync conflict in the real world | needs two machines and a project | sign in on two devices, edit the same conversation offline on both, sync |
| Renderer auto-scroll behaviour | jsdom has no layout | manual check in the running app |
