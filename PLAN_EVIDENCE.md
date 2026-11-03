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

## PART-001 — Baseline checkpoint and evidence run (complete)

**State:** PASSED. Owner approved the five open decisions on 2026-11-03; PART-001 executed, PART-002 not started.

| # | Step | Verdict | Evidence |
|---|---|---|---|
| 1 | Baseline state captured before any commit | **PASSED** | `.work/2026-11-03-audit-consolidation/logs/part-001-baseline.txt` — HEAD `76ad3e7`, branch `master`, 73 porcelain entries (6 ` M`, 4 `??`, 63 ` D`), `git diff --stat` = 69 files changed / 904 insertions / 18,818 deletions |
| 2 | Known-good baseline tagged | **PASSED** | `v0.1.0-baseline` → `git rev-parse v0.1.0-baseline^{commit}` = `76ad3e79bb7b05e3249759d4f26076e5aa2334fc` |
| 3 | Mobile client archived by tag | **PASSED** | `mobile-archive-2026-11-03` → same commit; `git ls-tree -r mobile-archive-2026-11-03 --name-only mobile` = **63 files**; `git cat-file -s mobile-archive-2026-11-03:mobile/package.json` = 1,309 B. `Test-Path mobile` → **False** (archived, not half-present) |
| 4 | Commit 1 — brand assets, reviewed alone | **PASSED** | `03341b7` `feat(brand): adopt the Grenjo AI mark as logo, app icon and installer icon` — 6 files, +341/−125; staged set inspected before commit (`git diff --cached --name-status`) and contained nothing else |
| 5 | Commit 2 — mobile archive, reviewed alone | **PASSED** | `e4c3d60` `chore(mobile): archive the stale Expo client out of the desktop tree` — **exactly 63 paths, 18,349 deletions, all under `mobile/`**; the "non-mobile staged" list printed empty |
| 6 | Commit 3 — documents, reviewed alone | **PASSED** | `0438336` `docs: add the Phase 1 audit, the v0.2 plan and the evidence log` — 4 files, +1,281/−344 |
| 7 | Working tree clean after the three commits | **PASSED** | `git status --porcelain` → **0 entries** |
| 8 | The tree is still green **after** the commits | **PASSED** | `.work/…/logs/part-001-postcommit.txt` at `0438336`: typecheck exit 0 · node **51 files / 601 tests** exit 0 · renderer **14 files / 157 tests** exit 0 · quality gate 144 files / 0 blocking exit 0 · build exit 0 (`dist/main` 1,249.79 kB, `dist/preload` 6.04 kB, CSS 67.17 kB, JS 718.31 kB — identical to the pre-commit baseline) |
| 9 | No user data, credential or schema touched | **PASSED** | The three commits touch `build/`, `scripts/`, `README.md`, `mobile/` deletions and `docs/`+plan files only. No file under `src/`, `supabase/`, `tests/`, no `.sqlite`/`.db`, no `.env*`, no migration. Schema stays at version 2 |
| 10 | Each phase is a separate reviewable commit | **PASSED** | Three commits, one concern each, in the owner's requested order (baseline tag → icon → archive → documents) |

**What was deliberately NOT done:** no cleanup, no dependency removal, no source change, no `.work/` or `release/`
sweep, no schema change, no push. PART-002 owns the first source change.

**One environment note for later parts:** the repo-local commit identity is still `Personal AI Desk
<dev@localhost>` (from `git config user.name`). It was left untouched because changing a git identity is the
owner's call, not a side effect of a baseline commit; every commit in this phase is authored under it.

## PART-002 — Consolidation: dead code and real defects (complete)

**State:** PASSED, with four items explicitly `UNAVAILABLE` (listed at the end — none is claimed as verified).
Ten commits, one concern each, on top of `0438336`. Total: 39 files, +1,182 / −348.

| Commit | Fix | What it does |
|---|---|---|
| `49228bf` | **D-01** | Defines `--size-prose: 65ch` and adds a token-integrity test |
| `27ae692` | **D-02** | Adds `media-src 'self' blob:` to the dev CSP and a parity test |
| `c22f1b9` | **D-03** | One `ConfirmDialog` replaces four copies; destructive confirms become `alertdialog` |
| `519934c` | **D-04** | `npm run dist` now runs `audit:gate`, `typecheck` and `test` first |
| `1379c28` | **D-05** | Removes the hardcoded `2026-10-29` sink from a script and the test harness |
| `4454089` | **D-06** | The quality gate scans `src`, `tests` and `scripts` (144 → 230 files) |
| `5cc2f24` | **D-07** | The Markdown doc comment now describes what the code does |
| `10800f0` | **D-09** | `resetAdHocDarwinSignature` for arm64 macOS |
| `a3446b6` | dead code | `providers/executor.ts` and its test removed (reference graph verified first) |
| `1c6cc21` | **D-08** | The two attach buttons request different, validated, derived filter lists |

### Reference-graph verification before the only tracked-file deletion

| Check | Result |
|---|---|
| Mentions of `executor` across `src/`, `tests/`, `scripts/` | 5 hits: the barrel re-export (2), two prose comments, and the module's own test import |
| Consumers of `runChat` / `runBuffered` | Only `executor.ts`, the barrel re-export and `executor.test.ts`. **No production caller.** |
| Dynamic `import(` inside `src/main/providers/` | none |
| Imports of the providers barrel (`./providers`, `providers/index`) | **none** |
| `ChatStreamHooks` consumers | defined in `executor.ts`, re-exported by the barrel, used nowhere else |
| How production actually runs a turn | `chat/service.ts:368` and `services/models.ts:191` call `transport.run(...)`, which handles `stream: false` at `transport.ts:152-153` |
| Coverage left behind | `transport.test.ts` exercises non-streaming `run`; the chat-service suites cover streaming, cancel and error paths (25 assertions) |

Deleted: `src/main/providers/executor.ts` (80 lines), its two barrel export lines, and
`tests/main/providers/executor.test.ts` (4 tests). Revert in one command:
`git checkout 0438336 -- src/main/providers/executor.ts src/main/providers/index.ts tests/main/providers/executor.test.ts`

### Each fix proven to fail before it passed

| Fix | Evidence it would have failed without the change |
|---|---|
| D-01 token | Removing the line → `tokens.test.ts` fails: `undefined custom properties:\nstyles/global.css:171 → --size-prose`, 2 of 3 tests red; restored → 3/3 green |
| D-02 CSP | Removing the directive from `devCsp` → `main-process dev policy allows blob media` fails; restored → 3/3 green |
| D-06 gate scope | A probe `tests/__gate-probe.test.ts` containing a `TODO` → `FAIL tests\__gate-probe.test.ts:1`, exit 1; the same probe in `src/` behaves as before; removing it → exit 0. Before this change the gate walked `src` only (144 files) and would have passed |
| D-05 sink | The smoke script wrote to `.work/2026-11-03-packaged-smoke/out/` (created at 22:13 by the run below) and nothing new appeared under `.work/2026-10-29-personal-ai-desk/out/` |
| D-03 / D-08 | Asserted by new tests, not by eye — see the counts below |

### Test and gate deltas against the PART-001 baseline

| Gate | PART-001 baseline | PART-002 | Delta |
|---|---|---|---|
| `npm run typecheck` | exit 0 | exit 0 | — |
| Node suite | 51 files / **601** tests | 52 files / **611** tests | −1 file (dead test), **+10 net** |
| Renderer suite | 14 files / **157** tests | 16 files / **175** tests | +2 files, **+18** |
| `quality-gate.mjs` | 144 files, 0 blocking | **230 files**, 0 blocking, 23 named waivers | +86 files now scanned |
| `npm run build` | exit 0, main 1,249.79 kB / preload 6.04 / CSS 67.17 / JS 718.31 | exit 0, main **1,251.33** / preload **6.06** / CSS **67.19** / JS **718.12** | main +1.54 kB (picker validation), renderer JS −0.19 kB (four dialog copies → one) |
| `npm run pack` | not run | **exit 0** — `release/win-unpacked/Grenjo AI Tool.exe` (246,111,744 B), fuses flipped `before={…49,48,49,49…} after={…48,49,48,48…}` | proves electron-builder accepts the new icon |

Test arithmetic: 601 − 4 (dead `executor.test.ts`) + 3 (tokens) + 3 (CSP parity) + 4 (attachment filters) + 7 (pick validation) = **611**.
Renderer: 157 + 3 (tokens) + 9 (ConfirmDialog) + 3 (models page regressions) + 3 (attach buttons) = **175**.

### Not verified in PART-002 (reported, not claimed)

| Item | Why | How to finish |
|---|---|---|
| Packaged-app launch (`npm run smoke:packaged`) | **UNAVAILABLE — environment.** A *pristine* Electron probe with no application code, every profile path redirected inside the workspace, exits with the same code `-2147483645` (0x80000003) and prints nothing, not even its first line. The one run that surfaced stderr showed Chromium's own failure: `process_singleton_win.cc:318] Lock file can not be created: Access is denied. (0x5)` and the same for its cache directories — the agent shell's file sandbox denies the writes Chromium needs at process init. This is not the app and not this change: no application JavaScript runs before the failure | From a normal desktop session: `npm run pack` then `npm run smoke:packaged` |
| The arm64 macOS signature fix (D-09) | **UNAVAILABLE — no mac host.** The option is set for `darwin` + `arm64` only, which is provable by reading; that the app then launches is not | On an arm64 mac: `npm run pack && open release/mac/Grenjo AI Tool.app` |
| The real OS file dialog's rendering of the filters (D-08) | The filter lists are asserted at the dialog port and every extension is re-checked against `classifyFile`, but no window was opened to look at the picker | Click both attach buttons in a running app (owner, one minute) |
| The rendered `alertdialog` and focus behaviour in a real window (D-03) | jsdom proves the ARIA role, focus target, Escape and restore; it cannot prove the rendered modal | Part of the Playwright pass approved as Q5 (PART-008) |

### Scope note — what PART-002 deliberately did not do

The audit also lists two configuration-hygiene items under the same part of the plan: the
`test:coverage` script that cannot run (no coverage provider installed, no root vitest config) and
the dead `scripts/**/*.mjs` include in `tsconfig.node.json` (no `allowJs`, so the scripts are not
typechecked despite the config claiming to cover them). The owner's PART-002 scope named the nine
audit defects, so these two were **left untouched and deferred to PART-003**, not silently folded in.

No database schema, migration, user data, credential or provider-architecture file was modified:
`schema_migrations` stays at version 2, `supabase/` is untouched, and `git diff 0438336..HEAD`
reports no file under `src/main/db/` or `supabase/`.

## PART-003 — Workspace truth: leftovers, docs, dependencies (complete)

**State:** PASSED, with the leftover sweep **planned and not executed** (no approval was given for a
deletion, and none was attempted). Four commits.

| Commit | Change | Verified by |
|---|---|---|
| `bd19006` | **D-10 / audit §3.6** — `highlight.js` removed from direct dependencies | `npm ls highlight.js` now shows only the transitive `lowlight` copy; direct count 26 → **25**; typecheck 0; markdown suite **7/7**; build 0; **renderer JS byte-identical at 718,120 B**, which proves it was never in the bundle |
| `0d642c1` | **H-01, H-02, H-04** — product name, test counts, bundle table, installer table, `.env.example` | greps below |
| `a3fafb7` | **H-03** — `backups/BACKUPS.md` registers both installers and the regenerable output | hashes measured, not copied: `Grenjo…exe` 125,299,894 B `55818C47…632349`; `Personal AI Desk…exe` 124,229,063 B `7223DEC3…81DA38` |
| `c952840` | config hygiene deferred from PART-002: `test:coverage` (could not run) and the dead `scripts/**/*.mjs` include | typecheck 0, build 0, both suites green, gate 0 blocking |

| Claim | Evidence |
|---|---|
| The old product name appears only where it is *the subject* | `grep -n "Personal AI Desk"` across `README.md`, `docs/`, `electron-builder.yml`, `.env.example` returns only the rename note (`README.md:10-12`), the legacy-profile migration notes (`FEATURES.md:26`, `THREAT-MODEL.md:102`, `electron-builder.yml:26-28`), the v0.1 installer row (`FEATURES.md:246`) and the archived plan under `docs/history/` |
| No stale `PERSONAL_AI_DESK_*` variable remains | `grep -rn "PERSONAL_AI_DESK"` → 0 hits outside the audit report's own findings table |
| The installer claims are true | `docs/FEATURES.md` now says the v0.1.0 Grenjo installer exists and is hashed, that the full lifecycle was only ever run on the pre-rename artifact, and that PART-013 re-certifies |
| Nothing was deleted in this part | `git diff 44085e5..HEAD --stat` shows no deletion outside `package-lock.json`'s 10 removed lines (the dropped dependency) |

**Leftover disposition:** `.work/…/out/leftover-plan-2026-11-03.md`. Two items are proposed for an S2 batch
(`release/win-unpacked/` ~426 MB, `.work/test-runtime/`), three are left `unsure`/cited, and **nothing was
removed** — the owner has not approved a batch, so the plan stops at the plan.

## PART-004 — Capability-based model registry (complete)

**State:** PASSED. Four commits. The blocker this part removes: **a model could only be a chat model**, and
discovery *deleted* every id that looked like anything else.

| Commit | What landed | Verified by |
|---|---|---|
| `a77175c` | 11-flag `ModelCapabilities`, `shared/capabilities.ts` (vocabulary, task routing, `makeCapabilities`), tolerant schema + codec + import path | typecheck 0 both projects; 611 node / 175 renderer; the four deep-equality assertions now describe eleven flags |
| `7f8181d` | discovery keeps every model and labels unknown ones `unclassified`; curated image/video hints with `shutdownDate`; probe refuses a non-text model | 611 node; three discovery assertions rewritten to the new contract |
| `c7cb927` | 12 unit tests over the routing rules + a legacy 0.1.0 export import test + retired-hint filtering in `catalog.ts` | node **624**, 54 files |
| `9b1d41c` | capability badges, grouped capability editor, task-gated chat and default-model pickers | renderer **195**, 19 files |

| Gate | PART-003 | PART-004 | Delta |
|---|---|---|---|
| typecheck | 0 | 0 | — |
| node tests | 611 | **624** | +13 (12 routing + 1 legacy import) |
| renderer tests | 175 | **195** | +20 (labels, editor, task gating, settings picker) |
| quality gate | 230 files | **235 files**, 0 blocking | +5 |
| build | 0, JS 718.12 kB | 0, JS **721.99 kB** | +3.87 kB, the capability UI |

**Proven, not asserted:**

| Claim | Evidence |
|---|---|
| A model can be an image model and nothing else | `supportsTask(imageModel,'image')===true`, `===false` for `'chat'` (`tests/node/capabilities.test.ts`) |
| An unclassified model is offered for **no** task | every `TaskKind` asserted false; `activeCapabilities(unclassified)` is `[]` |
| A missing capability record is never treated as a chat model | `supportsTask(null,'chat')===false`, `supportsTask(undefined,'chat')===false` |
| Nothing infers an output modality from a name | the only inference left is `IMAGE_INPUT_TOKENS` → `imageInput`; `isLikelyNonChat` yields `unclassified`, never `imageOutput` |
| A 0.1.0 export still imports | a payload with only the four original flags imports and yields `imageOutput:false` … rather than a skip |
| Discovery no longer hides models | deepseek/gemini/openai discovery tests now expect the non-chat id to be **present** with every flag false |
| A retired id cannot reach a picker or probe | `listCatalogModels` filters past `shutdownDate`; `chatgpt-image-latest` (2026-12-01) is in the hints as a real expired case |
| The chat and default-model pickers exclude non-text models | `tests/renderer/chat-model-picker.test.tsx`, `tests/renderer/pages/settings.test.tsx` |
| The capability editor cannot omit a flag | a test asserts every `CAPABILITY_KEYS` entry is reachable exactly once in the editor |

**New finding raised by the UI workstream and fixed in this part:** the Settings *Default model* picker had
the same defect as the chat picker — an image or undeclared model could be set as the default for every new
conversation. Fixed in `SettingsPage.tsx` with its own regression test.

**Not verified:** the rendered look of the badge row and the scroll behaviour of the longer capability editor
in a real window — jsdom proves the DOM contract, not the pixels. That is the Playwright pass in PART-008.

## PART-005 — Media store, job engine, IPC, `media://` (complete)

**State:** PASSED. Five pieces, five commits. Nothing in this part touched user data, credentials or an
existing migration; schema 3 is additive and the migration was proven on a live v2 database with rows in it.

| Commit | Piece | Verified by |
|---|---|---|
| `c663408` | **Schema 3** (`media`, `generation_jobs`), both repositories, content-addressed store | fresh file **and** v2-with-rows upgrade; traversal/absolute/oversize refused; atomic idempotent writes; 22 tests |
| `3ef1d2a` | **Job engine** — polling, backoff+jitter, per-provider throttle, cancel, deadline expiry, restart recovery | 16 tests, incl. "a rejection is never retried", "persist before success", "two overlapping ticks submit once", "expired ≠ failed" |
| `e85958e` | **Media service** — capability eligibility, storage, export/reveal, scheduler | 12 tests, incl. "a chat model cannot be handed an image job", "one file and one row", "restart writes one row" |
| `af8ff40` | **IPC surface** (9 channels + progress event) and the **`media://` protocol**; CSP for the scheme | 10 payload tests, 11 protocol/registry/CSP tests |
| `edde2d1` | Progress record | — |

| Gate | PART-004 | PART-005 | Delta |
|---|---|---|---|
| typecheck | 0 | 0 | — |
| node tests | 624 | **692** | +68 |
| renderer tests | 195 | 195 | — |
| quality gate | 235 files | **250 files**, 0 blocking | +15 |
| build | 0 | 0 | — |

**Proven, not asserted:**

| Claim | Evidence |
|---|---|
| The upgrade path is safe | a database at v2 **with a conversation and a message in it** is opened by the new build; the rows survive and the new tables come up usable |
| Nothing about user media is cascaded away | hard-deleting a conversation leaves the media row (links become NULL), asserted directly |
| Media is not in the sync set | absent columns *and* absent `SYNC_TABLES` entry, both asserted |
| A URL cannot become a path outside the root | `../../etc/passwd`, absolute paths and a URL-encoded traversal are refused by the store's pattern, and the protocol helper returns null for a foreign scheme or host |
| The renderer can display a file without loosening the network | all four CSP policies allow `media:` in `img-src`/`media-src` while `connect-src` stays `'none'`, asserted |
| Two ticks cannot double-submit | a test starts two `tick()` calls together and counts one submit |
| A job interrupted by a restart resumes exactly once | re-created engine over the same database writes exactly one media row |

**Deliberately not claimed:** no provider adapters are registered in this build, so `media.generate` answers
*"that provider does not have a generation adapter in this build"*. That is the seam working, not a working
feature. The protocol handler's Electron half (`protocol.handle`) is exercised only in a running app; the
decisions it depends on are unit-tested, and the handler itself is a packaged-app check for PART-013.

## PART-006 — Image adapters: OpenAI + Gemini (complete)

**State:** PASSED against fixtures. One commit (`ab9c93f`), 19 adapter tests + 5 protocol tests.

| Adapter | Request | Response | Proven by |
|---|---|---|---|
| `openaiImages.ts` | `/v1/images/generations`; `/v1/images/edits` when references exist (JSON `images[{image_url}]`, `mask`, ≤16) | `data[].b64_json` only; `output_format` → MIME; `size` → width/height | 9 tests: body shape, endpoint switch, header not URL, missing key refuses before HTTP, parse, empty-success is a failure, 401 vs 429, moderation |
| `geminiImages.ts` | `POST /v1beta/interactions`, `x-goog-api-key`, `input[]` blocks, `response_format[]` | `steps[] → model_output → content[type=image].data` | 6 tests: Interactions body (not chat), raw base64 not a data URL, undocumented `image_size` dropped, key in header only, thinking images ignored, empty reply fails |
| `media-adapter.ts` | — | — | 4 tests: status → shared code mapping, nested/flat/non-JSON error bodies |

**What is deliberately absent from the wire, and asserted so:** OpenAI sends no `negative_prompt`, `seed`,
`aspect_ratio` or `steps`; Gemini sends no negative prompt or output count. Those APIs do not document them,
the model catalogue does not offer them for these models, and a test asserts the keys are *absent* from the
body — the omission is gated at the UI, not silently applied at the adapter.

**Error vocabulary, mapped once for both providers:** `401/403 → invalid_key` (never retried),
`429/5xx → retryable`, `413 → bad_request`, a moderation refusal → `moderation_blocked` (never retried),
missing key → fails before any HTTP call with a sentence naming where to add one.

**A design change made here rather than carried forward:** adapters are built per provider kind on demand, not
cached. An adapter captures the base URL, and the app deliberately invalidates a stored key when its URL
changes — so a cache would keep sending a dead key to a stale endpoint. The registry module added in PART-005
became unnecessary and was **removed** in this commit rather than left as unused code.

**UNAVAILABLE, not claimed:** a live generation against either provider. No key exists in this workspace, so
request construction and parsing are proven and the calls are not. The exact command to prove it is in
PART-013's gate.

**Not yet reachable end to end:** the adapters accept reference images and a mask (the edits path is built and
tested), but the service does not supply them yet — its parameters are scalars by design. Wiring references
from a stored media row into `SubmitMediaInput` is PART-007's job, so image *editing* is implemented but not
yet exposed.

## PART-007 — Image service and persistence (complete)

**State:** PASSED. One commit (`80b1f13`), schema 4, 10 new tests.

| What landed | Why it matters | Verified by |
|---|---|---|
| **Schema 4**: `reference_ids`, `mask_media_id`, `conversation_id`, `message_id` on `generation_jobs` | A job that finishes after a restart must still know **what it was given** and **where its image goes** | additive `ALTER`s; applies to a fresh file **and** to a v2 database; newer-schema refusal still fires |
| Reference resolution at submit time | The file on disk is the authority, not what the renderer claimed | the adapter receives exactly the bytes the store holds; a deleted reference is skipped with a logged warning |
| Reference validation | Four failures become sentences instead of provider errors | unknown id, a video as a reference, a mask with no reference, more than 16 |
| Conversation link on job **and** media row | Listing by conversation works, and a resumed job lands in the right chat | a linked generation appears in `media.list({conversationId})`; an unlinked one stays unlinked |
| Export through the OS dialog | Already built in PART-005, now reachable with real media | export test copies the exact bytes to the chosen path |

**Image editing is now reachable end to end** (service → engine → adapter → `/images/edits`), which closes the
gap PART-006 recorded. It is proven with a fake adapter that records what it was handed; a live edit remains
`UNAVAILABLE` without a key.

**Deliberately not done here:** no assistant message is synthesised for a generated image. The media row carries
the conversation link and `media.list({conversationId})` returns it; how that appears *inside* the chat is
PART-011's decision, and inventing an empty assistant message now would put a phantom turn in every
conversation that generated something.

## PART-008 — Image Studio UI, with Playwright and axe (complete)

**State:** PASSED, and this is the first part whose *appearance* is verified rather than asserted. One commit
(`0f84961`).

**Tooling added first, as the owner required (`@playwright/test` 1.56.1, `@axe-core/playwright` 4.11.0).**

| Gate | Result |
|---|---|
| `npx playwright test` | **5 passed** in Chromium against the **built** bundle |
| layout @ 940×600 (the app's minimum) | `scrollWidth ≤ clientWidth` — no horizontal scrollbar |
| layout @ 1280×860 (the default) | same assertion |
| axe scan (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`) | **0 serious, 0 critical** violations |
| controls per provider | OpenAI: size, quality, count. Gemini: aspect ratio, resolution. No negative prompt for either |
| chat model in the image picker | asserted absent |
| jsdom suite | 195 → **205** (10 Image Studio tests: empty state, model filtering, per-provider params, empty prompt refused, live progress from a job event, cancel, named delete confirmation, export, preview) |

**Why a browser and not Electron:** Electron cannot start in this environment (PART-005 recorded the pristine
probe that fails identically), so the suite serves `dist/renderer` over HTTP and stubs the bridge. The page
under test is the shipped bundle; `media://` does not resolve there, so no test requires an image to decode —
they assert the DOM contract, the layout and the accessibility tree, which is exactly what jsdom cannot do.

**A shared-implementation cleanup made in passing:** the `media://` URL builder now lives once in
`shared/media.ts` and is used by both the main-process protocol handler and the renderer, instead of being
written twice.

**New npm scripts:** `test:e2e`, `serve:renderer`. `npm run dist` now runs the browser suite after the unit
suites, so a release cannot ship without the layout and accessibility gates.

**Not verified here:** the page against a live provider (no key), and the `media://` images themselves (the
handler is a packaged-app check for PART-013). `test-results/` and `playwright-report/` are gitignored.

## PART-009 — Video adapters and the async job lifecycle (complete)

**State:** PASSED against fixtures. One commit (`21a271a`), 18 new tests.

| Adapter | Contract | Verified by |
|---|---|---|
| `geminiVideo.ts` | `POST /interactions` with `background: true` → interaction id → `GET /interactions/{id}` until terminal → `steps[] → model_output → content[video]` | submit returns `pending` with the handle; poll returns the video; unknown status keeps polling; a provider-side failure is retryable; no key → no HTTP call |
| `bflVideo.ts` | `POST /v1/flux-3-video` with **`x-key`** → `{id, polling_url}` → poll `Ready/Error/Failed` → **download `result.sample` immediately** | x-key asserted and `Authorization` asserted absent; intermediate status keeps polling; ready → bytes fetched during the poll; failed/ready-without-URL handled |
| `media-download.ts` | HTTPS only, documented host + subdomains, redirects refused, 512 MB ceiling, bytes not text | 4 tests: dot-boundary host matching (`evil-bfl.ai` refused), foreign host not even fetched, oversize refused from the header, `[0x00,0xff,0x10,0x80]` round-trips exactly |

**The provider kind table gained `bfl`** — the first media-only provider. Its chat surface refuses by design
rather than pretending to work, and the guard is proved unreachable rather than assumed: every BFL model
declares `videoOutput` and **not** `chat`, so the picker cannot offer it, and a test asserts that for every
hint in `MODEL_HINTS.bfl`. Its preset has no chat parameters and no discovery, both asserted.

**Absences asserted, not just observed:** no `duration` for Gemini (it extends in ten-second steps and documents
no duration field), no image-to-video mode for BFL (`mode` is `t2v`; the second mode is unverified), no negative
prompt for either.

**Why BFL is the demanding case:** its result is a **signed URL valid for ten minutes**. The adapter downloads
it during the poll, so the store holds bytes and no row holds a URL that will be dead tomorrow. That is also
why the download helper refuses a redirect — a redirect would carry a request (and its key header) to a host
that is not the provider's.

**UNAVAILABLE, not claimed:** a live generation or poll against either provider. No key exists in this
workspace, so submit bodies, poll parsing, status mapping and the download path are proven and the network is
not.

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
| The four gates on every later part | all | re-run and recorded per part; PART-001's rows are the reference point |
