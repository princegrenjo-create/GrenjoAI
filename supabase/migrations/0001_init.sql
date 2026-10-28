-- Personal AI Desk — cloud sync schema (migration 0001).
--
-- Six owner-scoped tables. Every row belongs to exactly one Supabase auth user
-- and is identified by the *local* entity id, so the desktop app can push a row
-- it created offline without asking the server for an id.
--
-- The app is local-first: SQLite is the source of truth and this schema is the
-- optional cloud mirror. `version` is the local revision used for conflict
-- detection; `deleted_at` carries the tombstone so a delete can sync;
-- `payload` is the non-secret JSON body and never contains an API key.
--
-- Apply this file before 0002_rls.sql. Both are idempotent.

create table if not exists public.providers (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  payload jsonb not null
);

create unique index if not exists providers_user_id_id_key
  on public.providers (user_id, id);
create index if not exists providers_user_id_updated_at_idx
  on public.providers (user_id, updated_at);

create table if not exists public.models (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  payload jsonb not null
);

create unique index if not exists models_user_id_id_key
  on public.models (user_id, id);
create index if not exists models_user_id_updated_at_idx
  on public.models (user_id, updated_at);

create table if not exists public.agents (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  payload jsonb not null
);

create unique index if not exists agents_user_id_id_key
  on public.agents (user_id, id);
create index if not exists agents_user_id_updated_at_idx
  on public.agents (user_id, updated_at);

create table if not exists public.conversations (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  payload jsonb not null
);

create unique index if not exists conversations_user_id_id_key
  on public.conversations (user_id, id);
create index if not exists conversations_user_id_updated_at_idx
  on public.conversations (user_id, updated_at);

create table if not exists public.messages (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  payload jsonb not null
);

create unique index if not exists messages_user_id_id_key
  on public.messages (user_id, id);
create index if not exists messages_user_id_updated_at_idx
  on public.messages (user_id, updated_at);

create table if not exists public.settings (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  payload jsonb not null
);

create unique index if not exists settings_user_id_id_key
  on public.settings (user_id, id);
create index if not exists settings_user_id_updated_at_idx
  on public.settings (user_id, updated_at);
