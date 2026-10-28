-- Personal AI Desk — Row Level Security (migration 0002).
--
-- RLS is not optional. Without it, the publishable (anon) key that ships inside
-- the desktop app would read and write every user's rows. This file enables and
-- forces RLS on all six sync tables, removes the anonymous role entirely, and
-- gives the authenticated role exactly four owner-scoped policies per table:
--   <table>_select_own, <table>_insert_own, <table>_update_own, <table>_delete_own
--
-- Every USING / WITH CHECK clause is `auth.uid() = user_id`. The test suite
-- parses this file and fails if a table loses RLS or a policy disappears.
--
-- Apply after 0001_init.sql. Idempotent: policies are dropped and recreated.

alter table public.providers enable row level security;
alter table public.providers force row level security;
revoke all on public.providers from anon;
grant select, insert, update, delete on public.providers to authenticated;

drop policy if exists providers_select_own on public.providers;
create policy providers_select_own on public.providers
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists providers_insert_own on public.providers;
create policy providers_insert_own on public.providers
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists providers_update_own on public.providers;
create policy providers_update_own on public.providers
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists providers_delete_own on public.providers;
create policy providers_delete_own on public.providers
  for delete to authenticated
  using (auth.uid() = user_id);

alter table public.models enable row level security;
alter table public.models force row level security;
revoke all on public.models from anon;
grant select, insert, update, delete on public.models to authenticated;

drop policy if exists models_select_own on public.models;
create policy models_select_own on public.models
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists models_insert_own on public.models;
create policy models_insert_own on public.models
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists models_update_own on public.models;
create policy models_update_own on public.models
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists models_delete_own on public.models;
create policy models_delete_own on public.models
  for delete to authenticated
  using (auth.uid() = user_id);

alter table public.agents enable row level security;
alter table public.agents force row level security;
revoke all on public.agents from anon;
grant select, insert, update, delete on public.agents to authenticated;

drop policy if exists agents_select_own on public.agents;
create policy agents_select_own on public.agents
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists agents_insert_own on public.agents;
create policy agents_insert_own on public.agents
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists agents_update_own on public.agents;
create policy agents_update_own on public.agents
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists agents_delete_own on public.agents;
create policy agents_delete_own on public.agents
  for delete to authenticated
  using (auth.uid() = user_id);

alter table public.conversations enable row level security;
alter table public.conversations force row level security;
revoke all on public.conversations from anon;
grant select, insert, update, delete on public.conversations to authenticated;

drop policy if exists conversations_select_own on public.conversations;
create policy conversations_select_own on public.conversations
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists conversations_insert_own on public.conversations;
create policy conversations_insert_own on public.conversations
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists conversations_update_own on public.conversations;
create policy conversations_update_own on public.conversations
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists conversations_delete_own on public.conversations;
create policy conversations_delete_own on public.conversations
  for delete to authenticated
  using (auth.uid() = user_id);

alter table public.messages enable row level security;
alter table public.messages force row level security;
revoke all on public.messages from anon;
grant select, insert, update, delete on public.messages to authenticated;

drop policy if exists messages_select_own on public.messages;
create policy messages_select_own on public.messages
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists messages_insert_own on public.messages;
create policy messages_insert_own on public.messages
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists messages_update_own on public.messages;
create policy messages_update_own on public.messages
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists messages_delete_own on public.messages;
create policy messages_delete_own on public.messages
  for delete to authenticated
  using (auth.uid() = user_id);

alter table public.settings enable row level security;
alter table public.settings force row level security;
revoke all on public.settings from anon;
grant select, insert, update, delete on public.settings to authenticated;

drop policy if exists settings_select_own on public.settings;
create policy settings_select_own on public.settings
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists settings_insert_own on public.settings;
create policy settings_insert_own on public.settings
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists settings_update_own on public.settings;
create policy settings_update_own on public.settings
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists settings_delete_own on public.settings;
create policy settings_delete_own on public.settings
  for delete to authenticated
  using (auth.uid() = user_id);
