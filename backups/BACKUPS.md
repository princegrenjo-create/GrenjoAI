# Backup register

One row per backup artifact, with the disposition that decides what happens to it next. Nothing here has
been removed; this file exists so that a deletion later can be argued from a record instead of from
memory.

**Policy (organizer):** keep-latest per family — one `keep` (the newest *verified* copy), at most one
`previous` held as the fallback, everything older `supersede` and removable only with a per-item
confirmation that names it. **Safety floor:** the last copy of a family is never removed, and nothing is
removed while the newer copy has no restore evidence. A move frees no disk space; only a delete does.

**Verified** below means: the artifact was installed, launched and uninstalled by a person, or a file was
restored from it and a hash matched. A build that merely exited 0 is *not* verification.

| File | Family | Created | Bytes | SHA-256 | Disposition | Role | Verified | Note |
|---|---|---|---|---|---|---|---|---|
| `release/Personal AI Desk-Setup-0.1.0-x64.exe` | windows-installer | 2026-10-29 | 124,229,063 | `7223DEC30286CC3427185E27D2D69A84A78F6145CDCCA41B637FFE88AD81DA38` | **keep** | `previous` | **yes** — install → launch → 9/9 smoke → reinstall with data intact → uninstall with data preserved (`PLAN_EVIDENCE.md` PART-014) | The only installer whose full lifecycle was ever exercised. Pre-rename product name. |
| `release/Grenjo AI Tool-Setup-0.1.0-x64.exe` | windows-installer | 2026-10-29 | 125,299,894 | `55818C47…632349` | **keep** | `latest` | **no** — built and hashed, never install-tested | Supersedes the row above *only once* an install/launch/uninstall cycle is recorded for it. Until then both stay: the old one is the only evidence-backed artifact. |

## Regenerable build output (not backups)

These are outputs of a documented command, so they carry no restore obligation. They are listed here so
that a later sweep does not have to rediscover what they are.

| Path | Bytes | Regenerate with | Disposition |
|---|---|---|---|
| `release/win-unpacked/` | ~426 MB | `npm run pack` | disposable (S2); needs one batch approval, not a per-item confirmation |
| `dist/` | ~2 MB | `npm run build` | disposable (S2) |
| `node_modules/` | ~569 MB | `npm install` **then** `node node_modules/electron/install.js` (Electron 44 publishes no postinstall) | disposable (S2) |

## Restore drill (the thing that turns `keep` into `verified` for the current build)

Nothing has been restored from the v0.2 artifacts yet, because the v0.2 installer does not exist. When
PART-013 produces it, the drill is:

1. Install it into a scratch directory, launch it, confirm the First-run screen appears.
2. Copy a real `%APPDATA%\Grenjo AI Tool` profile aside, install over the top, launch, confirm the
   conversations and stored key still resolve.
3. Uninstall, confirm the program directory is gone and the profile is intact.
4. Record the hash, the cycle and the row above; only then may the older installer be proposed for
   `supersede` — and even then, by name, in its own confirmation.

## Not in this register

- `.work/` run sinks: agent scratch, gitignored, never a backup.
- `mobile-archive-2026-11-03` (git tag): a code archive, not a file backup; it is immutable by nature.
