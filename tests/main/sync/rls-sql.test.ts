import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../supabase/migrations');

const INIT_SQL = readFileSync(path.join(migrationsDir, '0001_init.sql'), 'utf8');
const RLS_SQL = readFileSync(path.join(migrationsDir, '0002_rls.sql'), 'utf8');

const EXPECTED_TABLES = [
  'providers',
  'models',
  'agents',
  'conversations',
  'messages',
  'settings',
] as const;

const OPERATIONS = ['select', 'insert', 'update', 'delete'] as const;

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const INIT = normalize(INIT_SQL);
const RLS = normalize(RLS_SQL);
const RLS_STATEMENTS = RLS.split(';')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

function createdTables(): string[] {
  const names: string[] = [];
  const pattern = /create table if not exists public\.([a-z_]+)/g;
  let match = pattern.exec(INIT);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined) names.push(name);
    match = pattern.exec(INIT);
  }
  return names.sort();
}

function tableBlock(table: string): string {
  const pattern = new RegExp(`create table if not exists public\\.${table} \\((.*?)\\);`);
  const match = pattern.exec(INIT);
  if (match === null) throw new Error(`table ${table} is missing from 0001_init.sql`);
  return match[1] ?? '';
}

function policiesFor(table: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const statement of RLS_STATEMENTS) {
    if (!statement.startsWith('create policy ')) continue;
    if (!statement.includes(` on public.${table} `)) continue;
    const operation = / for (select|insert|update|delete) /.exec(statement);
    if (operation === null) continue;
    const name = /^create policy ([a-z0-9_]+) /.exec(statement);
    found.set(name?.[1] ?? operation[1] ?? 'unknown', statement);
  }
  return found;
}

describe('cloud schema (0001_init.sql)', () => {
  it('creates exactly the six sync tables', () => {
    expect(createdTables()).toEqual([...EXPECTED_TABLES].sort());
  });

  it('gives every table the required columns and foreign key', () => {
    for (const table of EXPECTED_TABLES) {
      const block = tableBlock(table);
      expect(block, table).toContain('id text primary key');
      expect(block, table).toContain('user_id uuid not null references auth.users (id) on delete cascade');
      expect(block, table).toContain('version integer not null default 1');
      expect(block, table).toContain('updated_at timestamptz not null default now()');
      expect(block, table).toContain('deleted_at timestamptz');
      expect(block, table).toContain('payload jsonb not null');
    }
  });

  it('adds a unique (user_id, id) index and a (user_id, updated_at) index per table', () => {
    for (const table of EXPECTED_TABLES) {
      expect(INIT, table).toContain(
        `create unique index if not exists ${table}_user_id_id_key on public.${table} (user_id, id)`,
      );
      expect(INIT, table).toContain(
        `create index if not exists ${table}_user_id_updated_at_idx on public.${table} (user_id, updated_at)`,
      );
    }
  });
});

describe('row level security (0002_rls.sql)', () => {
  it('enables AND forces RLS on every table, with no table left out', () => {
    for (const table of EXPECTED_TABLES) {
      expect(RLS, table).toContain(`alter table public.${table} enable row level security`);
      expect(RLS, table).toContain(`alter table public.${table} force row level security`);
    }
  });

  it('defines all four owner policies per table, each restricted to auth.uid() = user_id', () => {
    for (const table of EXPECTED_TABLES) {
      const policies = policiesFor(table);
      expect(policies.size, `${table} policy count`).toBe(4);
      for (const operation of OPERATIONS) {
        const name = `${table}_${operation}_own`;
        const statement = policies.get(name);
        expect(statement, `${name} is missing`).toBeDefined();
        if (statement === undefined) continue;
        expect(statement, name).toContain('to authenticated');
        if (operation === 'select' || operation === 'update' || operation === 'delete') {
          expect(statement, name).toContain('using (auth.uid() = user_id)');
        }
        if (operation === 'insert') {
          expect(statement, name).toContain('with check (auth.uid() = user_id)');
          expect(statement, name).not.toContain('using (');
        }
        if (operation === 'update') {
          expect(statement, name).toContain('with check (auth.uid() = user_id)');
        }
      }
    }
  });

  it('never uses a permissive policy', () => {
    expect(RLS).not.toContain('using (true)');
    expect(RLS).not.toContain('with check (true)');
    expect(RLS).not.toMatch(/for all\b/);
  });

  it('revokes the anonymous role and grants the authenticated role', () => {
    for (const table of EXPECTED_TABLES) {
      expect(RLS, table).toContain(`revoke all on public.${table} from anon`);
      expect(RLS, table).toContain(
        `grant select, insert, update, delete on public.${table} to authenticated`,
      );
    }
  });
});
