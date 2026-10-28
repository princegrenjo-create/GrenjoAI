# Personal AI Desk — optional Supabase cloud sync

Sync is **off by default** and the app works fully without it. When it is enabled,
Personal AI Desk keeps SQLite as the source of truth and mirrors a small, non-secret
subset of it to a Supabase project that **you own**. Nothing is sent anywhere until you
paste a project URL and key and sign in.

## What an owner must do (one-time setup)

These are the exact steps. They have **not** been executed against a live project yet:
the real Supabase project does not exist in this workspace, so live-cloud verification is
**UNAVAILABLE**. The schema and policies are verified by the test suite against the SQL
files in `supabase/migrations/`; the network path is verified only against fakes.

1. **Create the project.** Sign in at <https://supabase.com/dashboard>, choose *New
   project*, pick a region near you, and set a strong database password. Wait for the
   project status to become *Active*.

2. **Open the SQL Editor** (left sidebar → *SQL Editor* → *New query*).

3. **Paste and run `migrations/0001_init.sql`.** It creates six tables: `providers`,
   `models`, `agents`, `conversations`, `messages`, `settings`. Every table is keyed by
   the local entity id, carries the owning `user_id`, a `version`, `updated_at`,
   `deleted_at` and a `payload jsonb` body.

4. **Paste and run `migrations/0002_rls.sql`.** It enables and forces Row Level Security
   on all six tables, revokes the anonymous role, and creates four owner policies per
   table (`<table>_select_own`, `<table>_insert_own`, `<table>_update_own`,
   `<table>_delete_own`). Re-running both files is safe.

5. **Confirm RLS actually took effect.** Run this in the SQL Editor and check that it
   returns six rows, each with `relrowsecurity = true`, `relforcerowsecurity = true`
   and `policy_count = 4`:

   ```sql
   select c.relname as table_name,
          c.relrowsecurity,
          c.relforcerowsecurity,
          count(p.polname) as policy_count
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   left join pg_policy p on p.polrelid = c.oid
   where n.nspname = 'public'
     and c.relname in ('providers','models','agents','conversations','messages','settings')
   group by 1, 2, 3
   order by 1;
   ```

6. **Enable email + password sign-in.** *Authentication → Providers → Email*: enable it.
   While testing, *Authentication → Sign In / Providers* may need *Confirm email* turned
   off (or use the confirmation link Supabase emails). The desktop app signs up and signs
   in with email and password only — there is no OAuth flow.

7. **Copy the project URL and the publishable key.** *Project Settings → API*:
   - Project URL, e.g. `https://<project-ref>.supabase.co`
   - **Publishable key** (older projects: the `anon` key). This is the key that is safe
     to use from a desktop client **because RLS is enabled**.

8. **Paste them into the app.** Settings → Sync → enable sync, enter the URL and the
   publishable key, then create an account or sign in. The URL is stored in settings;
   the key is stored in the **OS credential store**, never in SQLite and never in an
   export file.

## Which key is safe to ship, and which key must never be used

| Key | Use it? | Why |
| --- | --- | --- |
| Publishable key (`sb_publishable_...`) / legacy `anon` key | **Yes** | It is designed to be public. RLS policies decide which rows it can touch. |
| Secret key (`sb_secret_...`) / legacy `service_role` key | **Never** | It **bypasses Row Level Security** and can read and rewrite every user's data. |

The app refuses to configure sync with a secret key: `supabase/migrations` and the client
factory both treat a `service_role`/`sb_secret_` key as a configuration error. Do not put a
secret key in this repository, in `.env`, in a renderer bundle, in a screenshot or in an
issue report. If one leaks, rotate it in the Supabase dashboard immediately.

## What syncs and what never syncs

Synced (per signed-in user, scoped by RLS):
- providers — **name, kind, base URL and enabled flag only**; the API key itself never
  leaves the OS credential store;
- custom model definitions, agents, conversations, messages and non-secret settings.

Never synced:
- provider API keys, the Supabase key, the Supabase session/JWT (the session lives in the
  OS credential store behind the app, and only `auth.uid()` reaches the database);
- any value the engine recognises as credential-shaped: a payload field that *looks* like
  a key is stripped, and a free-text field that contains one is refused rather than
  silently rewritten.

## Data flow (what actually happens on "Sync now")

1. Pull: for `providers`, `models`, `agents`, `conversations`, `messages`, `settings`, in
   that order, ask for rows whose `updated_at` is newer than the stored watermark for the
   signed-in user.
2. Apply each row through the local repository. A remote row that is **not newer** than
   the local row is ignored (idempotent duplicate). A newer remote row over a **clean**
   local row is applied. A newer remote row over a **dirty** local row becomes a conflict
   and the local row is not overwritten.
3. Push: the same table order, from the durable local outbox. Each row is upserted with
   `onConflict: 'id'`. A row with an unresolved conflict is not pushed until the user
   resolves it, so a stale local edit cannot silently overwrite a newer remote row.
4. Counts refresh, `last_synced_at` updates, and failures are retried with exponential
   backoff (800 ms base, ×2, capped at 5 minutes, with jitter) recorded on the outbox row.
5. Every request is bounded: a Supabase call that does not answer within 30 seconds
   (configurable) is cancelled, reported as a retryable `timeout` error, and retried with
   the same backoff. A stalled socket can never leave the app stuck on "syncing".

## Troubleshooting

| Symptom in the app | Likely cause | Fix |
| --- | --- | --- |
| `sync_config`: "cloud tables are missing" | migrations not applied, or applied to another project | run 0001 and 0002 in *this* project |
| `sync_auth`: "row-level security denied this request" | signed out, or policies missing/wrong | sign in; re-run 0002 and the RLS check above |
| `sync_auth`: invalid credentials | wrong email/password, or email not confirmed | confirm the account or re-enter the password |
| `rate_limited` | Supabase throttling | wait; the engine backs off automatically |
| `timeout` | Supabase accepted the connection but did not answer in time | nothing to fix; the request is cancelled and retried with backoff |
| `offline` | no network | rows stay pending; the next online sync resumes |
| sync disabled in the UI | no URL/key stored | Settings → Sync |

## Limitations (honest status)

- Live-cloud verification is **UNAVAILABLE** until a real project exists. The engine is
  exercised only against an in-memory fake Supabase client and a fake local database.
- Conflicts are detected per row by `version` and resolved by the user (keep local / keep
  remote); there is no automatic merge.
- A pull-then-push cycle closes most of the window, but a second device that writes
  between this device's pull and push is resolved last-write-wins on the server: there is
  no server-side version guard yet, so a true multi-device concurrent edit is not
  prevented, only detected on the next pull. Use one device at a time for the moment.
- Rows deleted on the server are tombstones (`deleted_at`); there is no garbage
  collection job yet.
