# Claims audit — verifying the completion documents against the artefact

**Task:** team task-10 · **Owner:** platform-auditor (independent verifier — wrote none of this work)
**Revision audited:** `master` @ `0965c30` (working tree clean for every non-`mobile` path; the 63 `mobile/`
deletions are gone — the tree is fully clean)
**Environment:** Windows 10.0.26300, Node v24.18.0, npm 11.16.0, `danger-full-access` file policy
**Date:** 2026-11-03 23:32–00:05 local
**Documents under test:** `docs/RELEASE-GATE-2026-11-03.md`, `PLAN_EVIDENCE.md` (v0.2), `docs/PROJECT-AUDIT-2026-11-03.md`
**Constraints honoured:** no tracked file modified; no commit; no `npm run dist`; no installs. Writes only under
`.work/2026-11-03-audit-consolidation/` (deliverable + scratch). `npm run build` was run (explicitly permitted);
see §9 for exactly what it touched and how the tree was left.

---

## 1. Verdict in one line

**Every measured number in these documents is exact. One condition (C2) is misleading, and one diagnosis (C1)
is unsupported by its own evidence. The release gate is HONEST on results and MISLEADING in exactly one row.**

---

## 2. Claim-by-claim

Legend: **CONFIRMED** = I reproduced it. **WRONG** = contradicted by the artefact. **OVERSTATED** = true but
claims more than the evidence supports. **UNVERIFIABLE** = I could not test it, reason given.

### 2.1 The two headline claims the Lead flagged

| # | Claim (source) | Verdict | What I ran, and what came back |
|---|---|---|---|
| **A1** | **"10 Playwright tests, axe 0 serious/critical"** (gate §2 row 5; PLAN_EVIDENCE PART-013) | **CONFIRMED — and the assertion is genuinely live, not hollow** | `npx playwright test` → `10 passed (11.5s)`. `npx playwright test --list` → `Total: 10 tests in 2 files` (5 in `image-studio.spec.ts`, 5 in `video-studio.spec.ts`). **The assertion can fail.** I wrote three adversarial probes in `.work/…/tmp/axe-probe/` against the real built bundle, running the repo's own expression verbatim: <br>`const blocking = results.violations.filter(v => v.impact === 'serious' \|\| v.impact === 'critical'); expect(blocking.map(...)).toEqual([])`. <br>Probe A (real Image Studio page): 25 rules ran, **0 violations, 0 incomplete** → assertion passes. Probe A2 (real Video Studio page): same, 25 rules, 0/0. Probe B: I injected a bare `<img>` (rule `image-alt`, critical), a textless `<button>` (`button-name`, critical) and stripped `lang` from `<html>` (`html-has-lang`, serious) → axe returned exactly `button-name[critical], html-has-lang[serious], image-alt[critical]`, and **the repo's expression threw.** Probe C: the page really renders (`{"elements":150,"hasMain":1,"hasNav":1,"hasHeading":1,"buttons":7}`), and the 25 rules include `color-contrast`, `label`, `button-name`, `html-has-lang` — so the tag filter excludes nothing that could fire here. **The `impact` field is populated** (both branches exercised). Scope note, stated honestly: `withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa'])` deliberately excludes axe's non-WCAG "best-practice" rules (`region`, `heading-order`, …); that is a normal, defensible scope and the gate wording ("axe with 0 serious / 0 critical") is accurate for it. |
| **A2** | **C1: "a packaged launch is UNAVAILABLE because Electron cannot start here"** (gate §4 C1; PLAN_EVIDENCE PART-002/008/013) | **CONFIRMED as to the fact — the diagnosis is UNSUPPORTED** | My session runs under **`danger-full-access`**, i.e. the file sandbox the gate blames is not in force. Bare probe: trivial `main.cjs` (`app.whenReady()` and one `exit`), no app code. <br>• `node_modules/electron/dist/electron.exe <probe>` → **exit `-2147483645` = `0x80000003`**, stdout **empty** — not even `MAIN_ENTERED`, so no JS ran. <br>• Same with `--user-data-dir` redirected inside the workspace → `0x80000003`, still silent. <br>• **Stock Electron, no app at all** → `0x80000003`. <br>• **`electron.exe --version`** → `0x80000003` (it cannot even parse argv). <br>• `--no-sandbox` → `MAIN_ENTERED` printed, then **`0xC0000005`** (access violation) before `whenReady` resolved. <br>• The same binary as plain Node (`ELECTRON_RUN_AS_NODE=1 -e …`) → **exit 0**, `NODE_MODE_OK v24.22.1` — the executable is intact, so this is specific to Electron/Chromium init. <br>**Conclusion: the symptom and the `0x80000003` code are exactly as documented and the app genuinely cannot launch here — C1 is a legitimate UNAVAILABLE.** But the stated cause ("this shell's file sandbox denies the writes Chromium needs at process init") does not survive: it fails identically with the sandbox off, with a writable profile, with no app, and for `--version`. A one-line honest rewrite would be: *"Electron 44 cannot complete process init on this host (STATUS_BREAKPOINT, 0x80000003, before any JS; cause unidentified; reproduces with `electron.exe --version`)."* The gate states a cause it did not test. |

### 2.2 The remaining required checks

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| **B1** | "62 files, 737 tests" node suite (gate §2 row 3; PART-013) | **CONFIRMED exactly** | `npx vitest run --config vitest.node.config.ts` → `Test Files 62 passed \| 1 skipped (63)` · `Tests 737 passed \| 1 skipped (738)` · exit 0. The one skipped file is `profile-migration.drill.test.ts`, which self-skips without `DRILL_DB` — PART-013 discloses this ("+1 drill, skipped without `DRILL_DB`"), so 62/737 is the honest count of what ran. |
| **B2** | "22 files, 217 tests" renderer suite (gate §2 row 4) | **CONFIRMED exactly** | `npx vitest run --config vitest.renderer.config.ts` → `Test Files 22 passed (22)` · `Tests 217 passed (217)` · exit 0. |
| **B3** | Installer `124,981,226` bytes, sha256 `F6992BE6…EA48C2` (gate §1) | **CONFIRMED exactly** | `Get-Item` → `124981226`; `Get-FileHash -Algorithm SHA256` → `F6992BE632F5C2769C84AE6EF3624716FC6868EF78EBC77ED248B06A14EA48C2` — character-for-character identical. |
| **B4** | Migration drill: schema 2 → 4, 7 conversations (6 visible), 68 messages, 3 agents, 4 providers, 128 models, 1 settings row, `media`/`generation_jobs` created empty (gate §3; PART-013) | **CONFIRMED exactly — reproduced from scratch** | Copied `%APPDATA%\Grenjo AI Tool\data\app.db` (356,352 B) to `.work/…/tmp/drill-auditor/app-auditor.db`. **Before** (read-only census): `schema_version 2, conversations 7 (visible 6), messages 68, agents 3, providers 4, models 128, app_settings 1`. Ran `DRILL_DB=<copy> npx vitest run … profile-migration.drill.test.ts` → `1 passed`. The test printed `[drill] before={"schema_migrations":2,…}` / `[drill] after={"schema_migrations":4,"conversations":7,"messages":68,"agents":3,"providers":4,"models":128,"app_settings":1,"media":0,"generation_jobs":0,"schema_version":4,…}`. My own independent census of the copy afterwards: schema 4, every count unchanged, `media` and `generation_jobs` present at **0**. **Live profile untouched:** sha256 before and after = `21A55F57AB1C914FA1C32550FBF84FEDABABD60CCEF6C1761E8573DA107A6353`, mtime unchanged (`22:09:35`), and a read-only census of it still returns `schema_version 2`. |
| **B5** | "The icon extracted from the shipped exe is the Grenjo mark" (gate §2 row 9; PART-013) | **CONFIRMED** | `[System.Drawing.Icon]::ExtractAssociatedIcon` gives only 32×32, so I pulled the real frames with `PrivateExtractIcons` (16/32/48/64/128/256 all present). Compared **like-for-like at the same pixel size** against `build/icon-source.png`: @256 → meanAbsDiff **1.55**, corr **0.9975**; @128 → 3.78/0.9815; @32 → 3.41/0.9878. Visual read of the 256×256 extraction: the G-monogram/brain mark with the "Grenjo AI" wordmark — the owner's artwork. **Negative control** (proves the metric discriminates): the old procedural "spark" icon from `06142c3:build/icon.png` scores meanAbsDiff **37.36**, corr **0.474** against the same source. My first attempt said "DIFFERENT" — because I had upscaled a 32×32 extraction to 128×128; that was my artefact, not the project's, and re-measuring like-for-like reversed it. |
| **B6** | "`build/icon.png` / `icon.ico` / `icon.icns` are the same artwork, not a stale one" (PART-000 #3/#4/#7) | **CONFIRMED — including determinism and provenance** | Hashes match the document exactly: source `2C42C30B…CB08DF`, `icon.png` `5B2D1445…B248E9`, `icon.ico` `7443EE3C…3CE7`, `icon.icns` `43D16014…048A`. ICO has **7 frames** 16/24/32/48/64/128/256 @32bpp (372,526 B) exactly as claimed; ICNS has **7 PNG blocks** `icp4 797, icp5 2479, icp6 8030, ic07 25672, ic08 84126, ic09 249348, ic10 740673` — the document's numbers are the payload lengths (mine include the 8-byte block header; +8 each, so identical). I then copied `scripts/make-icon.mjs` + `build/icon-source.png` into an isolated tree under `.work/` and re-ran the generator: **all three outputs came out byte-identical to the committed files** — so the shipped icons provably came from that source via that script, and the generator is deterministic. |
| **B7** | "Fuses flipped in the shipped binary" (gate §2 row 10; `after={…48,49,48,48,49,49,48,49,49}`) | **CONFIRMED — read out of the binary, not the log** | `getCurrentFuseWire('release/win-unpacked/Grenjo AI Tool.exe')` → `{"0":48,"1":49,"2":48,"3":48,"4":49,"5":49,"6":48,"7":49,"8":49}` = `0,1,0,0,1,1,0,1,1` → `RunAsNode` **off**, `EnableNodeOptionsEnvironmentVariable` **off**, `EnableNodeCliInspectArguments` **off**, `EnableCookieEncryption` on, `OnlyLoadAppFromAsar` on, `EnableEmbeddedAsarIntegrityValidation` on. `after-pack.cjs` also carries the arm64 `resetAdHocDarwinSignature` guard. The document's byte array matches the live wire exactly. |
| **B8** | Version resource `FileVersion 0.1.0`, `ProductName Grenjo AI Tool` (gate §2 row 11) | **CONFIRMED** | `(Get-Item …exe).VersionInfo` → `FileVersion 0.1.0`, `ProductVersion 0.1.0.0`, `ProductName Grenjo AI Tool`, `FileDescription Grenjo AI Tool`. |
| **B9** | "installer is produced by one command that runs every gate first" (gate §1 "Build once, promote") | **CONFIRMED — and stronger than claimed** | `package.json` `dist` = `audit:gate && typecheck && test && build && test:e2e && electron-builder --win nsis`. I then **re-built the tree from `src/` and compared every shipped bundle inside `app.asar` against it**: `dist/main/index.cjs`, `dist/preload/index.cjs`, `dist/renderer/index.html`, `index-DqOkOS1y.css`, `index-lOwUyNHz.js` → **all five IDENTICAL (byte-for-byte)**. The installer ships the tree in front of me, not a stale build. `app.asar` also contains **0** paths under `src/`, `tests/`, `mobile/`, `.work/`, `release/` and no `.env`/`.db`/`.map`. |
| **B10** | "`npm audit:gate` → 275 files, 3 findings, 0 blocking" (gate §2 row 1) and "276 files, 0 blocking" (PART-013) | **CONFIRMED — and the 275/276 gap is explained, not a discrepancy** | `node scripts/quality-gate.mjs` → `276 files scanned, 3 findings (0 blocking, 3 allowed), exit 0`; the 3 are `service_role` named inside its own refusal guard. The gate's 275 is the number at the candidate commit `0b62192`; `da585de` — the same commit that added the release-gate document — also added `tests/main/db/profile-migration.drill.test.ts`, which the gate scans (SCAN_DIRS = `src`,`tests`,`scripts`) → 276. Both numbers are true at their moment. Nit: the gate does not timestamp its count. |
| **B11** | `typecheck` exit 0, `build` exit 0 (gate §2 rows 2 and 6) | **CONFIRMED — and the documented build quirk is real** | `npx tsc -p tsconfig.node.json --noEmit` → 0; `…web.json` → 0. `npm run build` **without** the TEMP override → exit 1, `[vite:esbuild-transpile] remove C:\Users\Jun\AppData\Local\Temp\esbuild-…: Access is denied` — exactly the quirk PLAN_EVIDENCE §PART-001 documents. With `TEMP`/`TMP` inside the workspace → exit 0, and the rebuilt bundles are byte-identical to the pre-existing `dist/` (same hashed filenames). The quirk is real and the workaround is correctly documented. |
| **B12** | C3 "no mac host" (gate §4) | **CONFIRMED** | `npx electron-builder --mac --dir --config electron-builder.yml` → `• electron-builder version=26.18.0` · `• loaded configuration file=D:\MyAI\electron-builder.yml` · `⨯ Build for macOS is supported only on macOS`, exit 1. Config loads (so the mac block parses), build refuses. Installer hash unchanged afterwards. The `mac:` block is real: dmg+zip × {x64, arm64}, `icon: build/icon.icns`, `category`, `hardenedRuntime: true`, `gatekeeperAssess: false`, `entitlements`/`entitlementsInherit`, `extendInfo.NSMicrophoneUsageDescription`, dmg `contents` with the `/Applications` link. Entitlements plist contains exactly the three claimed keys and nothing else. |
| **B13** | C5 "no certificate" (gate §4) | **CONFIRMED** | `Get-AuthenticodeSignature` on the installer → **`NotSigned`**; on `release/win-unpacked/Grenjo AI Tool.exe` → **`NotSigned`**. No `*.pfx/*.p12/*.pem` outside `node_modules`, `CSC_LINK` empty. |
| **B14** | C6 "install → launch → uninstall not run" | **UNVERIFIABLE here** | Installing writes to `%LOCALAPPDATA%` and the registry; that is outside this workspace and outside an audit's authority. The claim is a correct statement of why it was not done, and it is the owner's action either way. I did not attempt it. |
| **B15** | **C2 "no API key — UNAVAILABLE"** (gate §4 C2; §6 "it needs a key") | **WRONG — this is the one misleading row** | The live profile the drill used says otherwise. `SELECT kind,key_fingerprint FROM providers` → **deepseek, gemini and openai have a non-null `key_fingerprint`** with real `key_updated_at` values (`2026-10-28T20:11`, `2026-10-28T20:29`, `2026-10-29T08:20`); only `anthropic` is null. `credentials.bin` is **1,406 bytes**, a JSON store with `{"version","entries"}` and **6 entries** — three provider ids (`838a5f33…`, `56df045d…`, `e9624eb2…`) each with a companion `__provider…` record. The app's own definition confirms what that means: `rows.ts:168 hasKey: nullableStr(row.key_fingerprint) !== null`, and `providers.ts:55 keyFingerprint: key === null ? null : fingerprintSecret(key)` — a fingerprint exists **only because a key was saved**. So **`hasKey` is true for three providers**, and the gate's stated reason ("no API key exists in this workspace… a live call is the only proof, and it needs a key") is false. The **conclusion** — that no live call was made, so request/parse/retry against a real endpoint is unproven — remains true, and the gate does not claim otherwise. What is wrong is the *why*, and it matters: this is the difference between "cannot" and "did not", on the one capability that is the whole point of the release. **I did not make a live call** — that would spend the owner's credit and send their data to a third party, which is not an auditor's decision to take. So: keys are present and the app reports them usable; whether they are still *valid* is unknown. |

### 2.3 Spot-checks from PART-008…PART-013 and the SA-01…SA-13 fix table

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| C1 | PART-008: "jsdom +10 Image Studio tests" | **CONFIRMED** | `tests/renderer/**/image.test.tsx` = **10** `it(`/`test(` blocks. |
| C2 | PART-008: "the `media://` URL builder lives once in `shared/media.ts`" | **CONFIRMED** | `export function mediaUrl` at `shared/media.ts:164`; consumers are `src/main/media/protocol.ts:20` and the renderer's `MediaCard.tsx:12`, `ConversationMedia.tsx:15`. One definition, three callers — not duplicated. |
| C3 | PART-008: "`npm run dist` now runs the browser suite after the unit suites" | **CONFIRMED** | `dist` script chain (see B9). |
| C4 | PART-008: Playwright 1.56.1 / axe 4.11.0 installed | **CONFIRMED** | `node_modules/@playwright/test` = 1.56.1, `@axe-core/playwright` = 4.11.0. |
| C5 | PART-009: "dot-boundary host matching — `evil-bfl.ai` refused" | **CONFIRMED** | `tests/main/providers/video-adapters.test.ts:248-249` asserts both `evil-bfl.ai` and `bfl.ai.evil.test` are refused. |
| C6 | PART-010: "a job survives leaving the page" | **CONFIRMED** | `tests/renderer/video.test.tsx` header states exactly that scenario; the suite is part of the 217 passing. |
| C7 | PART-011: "media appears as a strip, not a synthesised assistant message" | **CONFIRMED** | `ConversationMedia.tsx` renders the strip from `media.list({conversationId})`; no assistant-message synthesis in the media service. |
| C8 | PART-012: packaged smoke is platform-aware (the old one "would have failed twice on a mac") | **CONFIRMED** | `scripts/smoke-packaged.mjs:50-54` picks `release/mac/<product>.app/Contents/MacOS/<product>` on darwin vs `release/win-unpacked/*.exe`; `:128-133` picks `~/Library/Application Support` vs `AppData`. `node --check` equivalent: the file parses and the suite's 9 checks are present (`checks` array = **9**, matching C1's "9 checks"). |
| C9 | PART-000 #5/#6: the generator rejects a corrupt source and writes nothing | **CONFIRMED-READ + reproduced indirectly** | The isolated re-run produced all three files and a clean exit; the CRC check is in the chunk walk. I did not repeat the byte-flip experiment (it needs a copy of the master, which I have — but the claim is already supported by the deterministic run plus the code). |
| C10 | PART-003 / SA-06: v0.1 plan "archived byte-identically under `docs/history/`" | **CONFIRMED** | `docs/history/MASTER_PLAN-v0.1.md` (24,343 B) sha256 `B0112D16…D1BDF53E` **=** `git cat-file blob 76ad3e7:MASTER_PLAN.md` sha256. Byte-identical. |
| C11 | PART-003: `highlight.js` removed from direct dependencies | **CONFIRMED** | `npm ls highlight.js` → only `rehype-highlight → lowlight → highlight.js@11.11.2`. No direct row. |
| C12 | PART-001 #2/#3: both tags point at `76ad3e7`, `mobile/` archived and gone | **CONFIRMED** | `git cat-file -p` both tag objects → `object 76ad3e79bb…`; `git ls-tree -r mobile-archive-2026-11-03 --name-only mobile` = **63 files**; `Test-Path mobile` = `False`. (My first read printed `14c1fd6` — a PowerShell argument-mangling artefact of `^{commit}`; re-running quoted gave the correct SHA. Flagging my own error rather than the project's.) |
| C13 | SA-01: the scope sentence now names every path the run touched | **CONFIRMED** | `PROJECT-AUDIT-2026-11-03.md:5-10` lists the two replaced icon binaries, the rewritten `make-icon.mjs`, the two new assets, the README line and the documents. |
| C14 | SA-02: both tree censuses recorded | **CONFIRMED** | `PLAN_EVIDENCE.md:188` records 63→69→73 with the moment each was true. |
| C15 | SA-07: direct-dependency count corrected | **CONFIRMED** | PART-003 says "direct count 26 → 25". Today: 10 runtime + 17 dev = 27, because PART-008 added `@playwright/test` + `@axe-core/playwright` (+2) after the removal. The arithmetic is consistent; no document states a stale count. |
| C16 | SA-11/SA-12: CRC check, write-then-rename, opaque-master caveat recorded | **CONFIRMED** | The generator's chunk walk verifies CRCs; `PLAN_EVIDENCE.md:175` carries the "shipped master is fully opaque, so the delivered files do not exercise the alpha path" caveat. |
| C17 | §12 "independently audited by a member who wrote none of it; 13 findings; 23 of 24 numbers exact; 4/4 baseline rows reproduced" | **CONFIRMED — the self-description is accurate** | `.work/…/out/lead-audit.md` exists (25,747 B), verdict **"YES WITH FIXES — no blocker, no fabricated evidence"**, an SA-01…**SA-13** table (13 rows) with `file:line` evidence, and its own scoreboard: "*Verifiable numeric claims checked 24, **23 exact**, 1 off by one (SA-07)*" and "*PASSED evidence rows re-executed 4 of 4 reproduced exactly*". Every SA fix I could check is applied in the delivered text. **This is the strongest honesty signal in the set:** the project published the criticism of its own audit, and the criticism was real. |

### 2.4 Small defects found (none changes a decision)

| ID | Finding | Severity |
|---|---|---|
| **D-1** | `build/entitlements.mac.plist` says *"see the **A8** assumption in `docs/THREAT-MODEL.md`"*, but the entitlement widening is **A11** (`THREAT-MODEL.md:128`); A8 (`:177`) is the "recording uploaded before the owner asks" threat. Wrong cross-reference inside a security artifact. (PLAN_EVIDENCE PART-012 correctly says A11.) | nit |
| **D-2** | The release gate quotes the gate's file count (275) without the timestamp that makes it true; the evidence log quotes 276 for the same gate. Explained by chronology (§B10), but two documents disagree on its face. | nit |
| **D-3** | `tests/node/shared.test.ts:245` still names the old hard-coded sink path in a comment; D-05 removed the *functional* hard-coding (verified: `smoke-packaged.mjs` now uses `${localDate()}-packaged-smoke`, `helpers.ts` uses `.work/test-runtime`). | nit |
| **D-4** | Gate C1's mechanism sentence (file sandbox) is not what the evidence shows (see A2). The conclusion is right; the explanation should be deleted or replaced with "cause unidentified". | should-fix (wording, because it tells the owner a wrong thing about their own machine) |
| **D-5** | Gate C2's stated reason is contradicted by the profile (see B15). | **should-fix — the one row that misleads** |

---

## 3. Most significant discrepancy

**C2, and only C2.** The gate tells the owner that a live provider call is impossible "because no API key exists in
this workspace". The workspace disproves it: the same live profile the migration drill was run against holds
`key_fingerprint` values and `key_updated_at` timestamps for **deepseek, gemini and openai**, and `credentials.bin`
holds three encrypted entries plus their URL-binding records — 1,406 bytes of keystore that the app itself reports
as `hasKey: true` (`rows.ts:168`, `providers.ts:55`). The v0.1 documents made the same claim about the same keys
(`FEATURES.md` then: "no API key in this workspace"), so the error is inherited, not invented for this gate — but it
is repeated in a release gate, where it converts "we did not test the product's primary function" into "we could not".
Everything else checks out, and several claims are stronger than they needed to be (see §4).

The runner-up is C1's *explanation*, which is not the same severity: the launch genuinely fails, reproducibly, with
the exact code the documents cite — but the reason given (the file sandbox) is contradicted by the fact that it fails
identically with the sandbox disabled.

---

## 4. What I tried to break, and could not

Each of these was an attack, not a confirmation exercise. Every one failed to find inflation:

1. **Hollow axe assertion** — the classic failure is a filter that drops everything (`impact` never populated) or a
   scan of an empty page. Both disproved: injected critical **and** serious violations were caught by the repo's own
   expression, and the DOM has 150 elements with 25 rules passing. (§A1)
2. **Icon matched by a lax metric** — my first measurement said "DIFFERENT" (32 px upscaled to 128). Re-measuring
   like-for-like reversed it, and a negative control against the *old* spark scores 37.36/0.474 versus 1.55/0.9975 —
   the metric separates them by a factor of 24. (§B5)
3. **Icon provenance faked by hand-editing** — an isolated re-run of the generator reproduced all three committed
   hashes byte-for-byte from `icon-source.png`. (§B6)
4. **Drill numbers copied from a previous run** — I copied the live DB myself, censused it before, ran the drill, and
   censused after; the printed before/after match the table line for line, and the live file's sha256 is unchanged. (§B4)
5. **Installer hash of a different artifact** — recomputed; identical. **Installer shipping stale code** — every
   bundle inside `app.asar` is byte-identical to a fresh build of this tree. (§B3, §B9)
6. **Fuses claimed from a log** — read the fuse wire out of the shipped exe instead. Identical to the claim. (§B7)
7. **"Electron can't start" as a convenient excuse** — tested 7 ways including `--version`, stock Electron, a
   writable profile, sandbox off, and the same binary as Node. It genuinely cannot start — *but* the stated cause
   does not survive. The excuse is real; the explanation is not. (§A2)
8. **Numeric drift between documents** — chased the 275/276 gate count to a specific commit and explained it rather
   than reporting it as an error. (§B10)
9. **Self-audit dressed as independent review** — read the cited `lead-audit.md`: it is a real 13-finding critique
   with `file:line` evidence, a verdict that flags 6 should-fix items, and its own admission that 1 of 24 numbers was
   off. The §12 summary of it is accurate, including the "23 of 24". (§C17)
10. **A gate that quietly claims success on an untested path** — C6 (install cycle) and C2 (live call) are both
    explicitly labelled not-proven, and C4 *volunteers* that the version was never bumped. Only C2's reason is wrong;
    none of them claims a pass.

---

## 5. Verdict on the release gate's honesty

**HONEST — with one misleading condition (C2) and one unsupported diagnosis (C1).**

Reasoning, in the order that matters:

- **The numbers are not massaged.** Every quantitative claim I could measure is exact — to the byte, the test count,
  the file count, the sha256 character, the drill row. That is 20+ independent numbers, and the only "miss" in the
  whole set (275 vs 276) is a chronology artefact that resolves in the project's favour once traced.
- **The gate admits what it did not do, in the direction that costs it.** C4 volunteers that the version was never
  bumped and that two different artefacts would share `0.1.0`; §5 lists the NO-GO triggers and confirms none fired;
  C1/C2/C3/C5/C6 are all labelled not-proven. A document that wanted to look finished would not write C4 at all.
- **The self-correction is real, not decorative.** The project published an independent audit of its own audit
  (SA-01…SA-13), and every fix I checked is in the delivered text; `docs/history/` really is byte-identical.
- **Where it fails is in *why*, not in *what*.** C1 gives a cause its evidence does not support (the file sandbox is
  not the reason — it fails with the sandbox off). C2 gives a reason that its own profile falsifies (three keys are
  stored). In both cases the *conclusion* stands and the *justification* does not. That is the pattern of a document
  written by someone reasoning from a shell they were fighting, not of one inflating results.
- **The one that changes a decision is C2.** The owner is told the app's primary capability cannot be proven here
  when in fact three providers are keyed and ready: they can close C2 themselves in minutes, and the gate should have
  said "not attempted; keys are present". As written, the row is misleading. Nothing else is.

If the owner wants a single word for the row: **C2 is MISLEADING.** For the document: **HONEST.**

---

## 6. What I could not check, and why

| Item | Why | How to close it |
|---|---|---|
| That the stored keys are still valid | A live call spends the owner's credit and sends their content to a third party — not an auditor's call | Owner: Models & Providers → *Test connection* → one image and one video |
| C6 install → launch → uninstall | Installs to `%LOCALAPPDATA%` and the registry, outside the workspace | Owner, one run of the installer |
| A packaged launch (the real app, not my probe) | Same `0x80000003` as a pristine probe — no application code runs, so the smoke test cannot reach any of its 9 checks | From a normal desktop session: `npm run smoke:packaged` |
| A macOS bundle | No mac host (electron-builder refuses, verified) | `npm run pack:mac` on a mac |
| PART-004…PART-010 per-part test counts (624, 692, 205, 212 …) | They are historical snapshots; re-running them needs a checkout of each commit in a separate worktree, which a read-only audit does not do | The aggregate is verified (737/217/10) and each part's *added* tests I could name are present |
| The live provider request bodies | No live call (see above) | Same as row 1; the shapes are asserted by the suites, which pass |

---

## 7. Side effects of this audit, and the tree as I leave it

- `npm run build` was run twice: once **without** the TEMP override (to test the documented quirk — it failed as
  documented), once **with** it (exit 0). This rewrote `dist/` (gitignored build output) with byte-identical files;
  `dist/` is complete and consistent, verified against `app.asar`.
- `npx electron-builder --mac --dir` was attempted and refused at its own guard; `release/` is unchanged (installer
  hash identical before and after).
- Everything else was read-only. No tracked file was created, modified, moved or deleted; `git status --porcelain`
  is empty for every non-`mobile` path (and `mobile/` is archived, not dirty).

### Path audit (organizer)

| Path | Class | What |
|---|---|---|
| `.work/2026-11-03-audit-consolidation/out/claims-audit.md` | **sink** | this deliverable |
| `.work/…/tmp/axe-probe/{playwright.config.ts, axe-can-fail.spec.ts}` | sink | the adversarial axe probe (4 tests, all pass) |
| `.work/…/tmp/icon-probe.ps1`, `icon-probe-256.ps1`, `icon-probe/` (thumbnails, 256 px extraction, old spark) | sink | icon provenance + negative control |
| `.work/…/tmp/electron-probe/{main.cjs, package.json}`, `userdata/` | sink | the bare Electron probe |
| `.work/…/tmp/drill-auditor/{app-auditor.db, census-auditor.mjs}` | sink | the migration drill on my own copy |
| `.work/…/tmp/icon-determinism/` | sink | isolated generator re-run |
| `.work/…/tmp/asar-extract/`, `asar-vs-dist.mjs` | sink | asar ↔ rebuild comparison |
| `.work/…/tmp/build-temp/`, `old-master-plan.md` | sink | build TEMP redirect, archive hash check |

Nothing was written outside `.work/`. The pre-existing files another workstream left in this sink
(`raw/shipped-icon.png`, `tmp/drill/*`, `tmp/auditor/*`) were read, never overwritten — my probe lives in
`tmp/axe-probe`, `tmp/icon-probe`, `tmp/drill-auditor`, `tmp/electron-probe` to keep the two disjoint.

> **Status note (added when this report was promoted out of the run sink).**
> The audit is unedited. Its two corrections were acted on: the gate's C1 explanation was wrong and is
> withdrawn, and C2's "no API key exists" was false and is corrected in `docs/RELEASE-GATE-2026-11-03.md` —
> three providers carry key fingerprints, and a live call was not made because it spends the owner's credit.
