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

---

# v0.2 evidence log

Everything below is from the **v0.2** plan (`MASTER_PLAN.md`). Verdicts: **PASSED** (command ran here, output
quoted), **CONFIRMED-READ** (code/config read at the cited line; not executed), **RELAYED** (produced by a
named audit workstream, evidence path given), **UNAVAILABLE** (precondition missing, steps recorded).

Run sink: `.work/2026-11-03-audit-consolidation/` (gitignored). Phase-1 audit:
`docs/PROJECT-AUDIT-2026-11-03.md`. Workstream evidence: `.work/2026-11-03-audit-consolidation/out/`
(`core-audit.md`, `ui-audit.md`, `platform-audit.md`, `provider-matrix.md`).

## PART-000 — Brand assets (delivered 2026-11-03)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | The supplied artwork is the icon master and is byte-identical to the attachment | **PASSED** | `Copy-Item` from the attachment object → `build/icon-source.png`, 685,535 B, sha256 `2C42C30BE6B4656AA88AECBF8304E4C60BDFE7DEABF7E94CEB78A04344CB08DF` (matches the attachment hash) |
| 2 | The generator runs with no new dependency | **PASSED** | `node scripts/make-icon.mjs` → exit 0, `[icon] source 1024x1024 -> icon.png 740673 B, icon.ico 372526 B (16/24/32/48/64/128/256), icon.icns 1111189 B`; `package.json` unchanged |
| 3 | The ICO is structurally valid at every size | **PASSED** | probe `.work/…/tmp/verify-icons.mjs`: 7/7 entries PASS — for each, `off+len ≤ file length`, `biSize=40`, `biWidth=w`, `biHeight=2h`, 32 bpp, `bytesInRes = 40 + w·h·4 + maskRow·h`; total 372,526 B |
| 4 | The ICNS is structurally valid | **PASSED** | same probe: `magic=icns declared=1111189 actual=1111189`, 7 entries `icp4:797 icp5:2479 icp6:8030 ic07:25672 ic08:84126 ic09:249348 ic10:740673`, each a PNG payload, walk ended exactly at file length |
| 5 | Resampling preserves colour and geometry (first attempt was wrong) | **PASSED** | First render returned a white box: un-premultiply used `255/(a/255)` instead of `255/alphaOut`. Fixed to `(r/weight)·(255/alphaOut)`; spot-checked `master(100,900)=#090D0E` vs `icon32(3,28)=#0A0C0E`, `master(512,400)=#FAFEFD` vs `icon256(128,100)=#C5CCCF` (area-averaged). The bug is recorded because the first output *looked* plausible in a file listing. **Note the shipped master is fully opaque**, so the delivered files do not themselves exercise the alpha path; the independent audit exercised it with a synthetic 0→255 alpha ramp at constant colour and measured **zero drift** across 48 alpha levels |
| 6 | The decoder rejects a corrupt master instead of shipping a wrong icon | **PASSED** | Added a per-chunk CRC check and write-then-rename. Flipping one byte at offset 5000 of a copy of the master → `chunk IDAT failed its CRC check (corrupt or truncated file)`, exit 1, **no output written**; the master was restored and re-hashed to `2C42C30B…CB08DF` |
| 7 | The generator is deterministic | **PASSED** | Re-running it leaves all three hashes unchanged: `icon.png` `5B2D1445…B248E9`, `icon.ico` `7443EE3C…3CE7`, `icon.icns` `43D16014…048A` |
| 8 | Small sizes were inspected, not assumed | **PASSED** | 16/32/48/256 px PNGs written to `.work/…/raw/icon-preview/` and viewed: the mark reads as a glowing circuit "C"; the wordmark is a smudge below 48 px. Reported as a limitation, with the mark-only crop offered as an optional follow-up |
| 9 | `build/icon.ico` is what the Windows installer will use | **CONFIRMED-READ** | `electron-builder.yml:34` `win.icon: build/icon.ico`; `directories.buildResources: build` |
| 10 | The packaged installer carries the new icon | **PLANNED** | needs `npm run dist` (PART-013); not run in this phase |

## PART-001 (audit input) — baseline facts

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Tracked files | **PASSED** | `git ls-files \| Measure-Object` → **326**; `src` 157, `tests` 78, `mobile` 63, `scripts` 5, `supabase` 3, `docs` 2, `build` 2 |
| 2 | HEAD and branch | **PASSED** | `git rev-parse HEAD` → `76ad3e79bb7b05e3249759d4f26076e5aa2334fc`; branch `master` |
| 3 | The working tree is not clean | **PASSED** | `git status --porcelain` → 63 ` D mobile/…`; after the brand work and before the documents: **69** entries (3 ` M` + 2 `??` + 63 deletions). After the plan/audit/evidence documents are written the same census reads **73** (6 ` M` + 4 `??` + 63 ` D`). Both numbers are true at different moments; the 63 deletions pre-date this run |
| 4 | `--size-prose` is referenced 6× and defined 0× | **PASSED** | `grep -rn -- "--size-prose" src` → 6 hits (`global.css:171`, `controls.css:731,832`, `overlays.css:53`, `markdown.css:25`, `shell.css:210`), none a definition |
| 5 | Discovery deletes non-chat model ids | **CONFIRMED-READ** | `openaiFamily.ts:77-78` `NON_CHAT_MODEL_PATTERN = /(^\|[-_/])(embedding\|…\|dall-e\|image\|images\|sora\|…)([-_/]\|$)/i`, applied to the discovery result |
| 6 | One authoritative concern per area (no duplicated provider layer in `src/`) | **RELAYED** | `out/core-audit.md` §Area inventory, F-01; thin adapters `openai.ts` 152 L / `openaiCompatible.ts` 56 L / `deepseek.ts` 48 L over `openaiFamily.ts` 385 L |
| 7 | `mobile/` duplicates 11 files / 2,526 lines of `src/` | **RELAYED** | `out/platform-audit.md` F-14, `git ls-tree -r HEAD` blob-SHA comparison |
| 8 | Exactly one unused direct dependency | **RELAYED** | `out/platform-audit.md` F-10, §3 dependency verdict table: `highlight.js@11.12.0`, 0 imports across 239 files |
| 9 | `npm audit --omit=dev` → 0 vulnerabilities | **RELAYED** | `out/platform-audit.md` F-21 |
| 10 | The app's packaging is clean (no `src/`, `tests/`, `mobile/`, `.env`, `.db`, `.map` in `app.asar`) | **RELAYED** | `out/platform-audit.md` F-19: 6,057 asar entries, 9 under `dist/`, 147 production packages, 0 forbidden paths |
| 11 | OpenAI image API state (model list, `/images/variations` retired, `gpt-image-1` shut down 2026-10-23, 16 refs, mask/markup, arbitrary `WxH` ÷16, base64-only, `n` 1–10) | **PASSED** | Lead re-fetched `https://developers.openai.com/api/reference/resources/images.md` (HTTP 200) and read the parameter tables; matches `out/provider-matrix.md` §2 |
| 12 | OpenAI has no public video API | **RELAYED** + **CONFIRMED** by matrix | `out/provider-matrix.md` §5 quotes the shutdown banner and the deprecations table (replacement `---`); not re-fetched by the Lead |

## PART-001 pre-check — the tree is green before anything changes

Run on `D:\MyAI` at HEAD `76ad3e7` + the brand-asset worktree changes, **before** any consolidation.

| # | Command | Verdict | Evidence |
|---|---|---|---|
| 1 | `npm run typecheck` | **PASSED** | exit 0 (both projects: `tsconfig.node.json`, `tsconfig.web.json`) |
| 2 | `npx vitest run --config vitest.node.config.ts` | **PASSED** | exit 0 — **51 files, 601 tests passed** |
| 3 | `npx vitest run --config vitest.renderer.config.ts` | **PASSED** | exit 0 — **14 files, 157 tests passed** |
| 4 | `node scripts/quality-gate.mjs` | **PASSED** | exit 0 — `144 files scanned, 3 findings (0 blocking, 3 allowed)`; the three are `service_role` named inside its own refusal guard |
| 5 | `npm run build` | **PASSED with an env override** | exit 0 — `dist/main/index.cjs` 1,249.79 kB (gzip 254.66), `dist/preload/index.cjs` 6.04 kB, `renderer/assets/index-B_EQ9JqM.css` 67.17 kB, `renderer/assets/index-DcELI0SO.js` 718.31 kB (gzip 218.19). These match the sizes recorded independently in `out/platform-audit.md` F-18, so the shipped tree and the measured tree are the same |

**The build needs one environmental workaround on this host.** Plain `npm run build` failed with
`[vite:esbuild-transpile] remove C:\Users\Jun\AppData\Local\Temp\esbuild-…: Access is denied` — esbuild cannot
delete its own temp file under the platform temp directory. Redirecting `TEMP`/`TMP` into the run sink made it
pass:

```powershell
$env:TEMP='D:\MyAI\.work\<run>\tmp\build-temp'; $env:TMP=$env:TEMP; npm run build
```

This is an **environment constraint, not a code defect**: no source, config or dependency was changed to fix
it, and the failure is recorded rather than hidden. Every later part that runs a build must set these two
variables, or it will record a failure that has nothing to do with the change under test.

## Cross-cutting: the environment has two known quirks

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `pwsh` failed under the initial `workspace-write` file policy with `STATUS_DLL_INIT_FAILED` | **PASSED** (observed) | four attempts → `[exit code: 3221225794]`, including a background job; identical after a fresh process |
| 2 | The same command succeeds under `danger-full-access` | **PASSED** | git/tree/icon commands all returned output once the policy changed; the session is now on `danger-full-access` |
| 3 | `esbuild` cannot write/remove under `%TEMP%` on this host | **PASSED** | `npm run build` → `Access is denied` on `%TEMP%\esbuild-…`; identical build passes with `TEMP`/`TMP` pointed inside the workspace |
| 4 | Consequence | noted | shell commands need a non-sandboxed session, and builds need a workspace `TEMP`. Both are recorded as preconditions of every later part rather than surprises |

## Not yet evidenced (belongs to later parts)

| Item | Part | How it will be proven |
|---|---|---|
| Any generated image or video from a live provider | PART-006, PART-009 | requires the owner's API keys → `UNAVAILABLE` otherwise |
| A macOS build | PART-012 | requires a macOS host → `UNAVAILABLE` on this machine |
| The packaged installer carrying the new icon | PART-013 | `npm run dist` + hash + the icon extracted from the exe |
| The baseline being re-confirmed on the **tagged** commit | PART-001 | the four commands above, re-run after `v0.1.0-baseline` and the two commits |
