import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@main/db/index';
import { TestDatabase } from './helpers';

let t: TestDatabase;

beforeEach(() => {
  t = new TestDatabase();
});

afterEach(() => {
  t.dispose();
});

function rawAgent(id: string): Record<string, unknown> | null {
  return t.db.sql.get<Record<string, unknown>>('SELECT * FROM agents WHERE id = ?', [id]);
}

describe('agents', () => {
  it('creates, reads and lists agents', () => {
    const created = t.db.agents.create({
      name: 'Code reviewer',
      description: 'Reviews diffs',
      systemPrompt: 'You review code.',
      params: { temperature: 0.1 },
    });

    expect(created.name).toBe('Code reviewer');
    expect(created.description).toBe('Reviews diffs');
    expect(created.systemPrompt).toBe('You review code.');
    expect(created.params).toEqual({ temperature: 0.1 });
    expect(created.syncState).toBe('pending');

    expect(t.db.agents.get(created.id)).toEqual(created);
    expect(t.db.agents.list()).toHaveLength(1);
    expect(t.db.agents.count()).toBe(1);
  });

  it('defaults optional fields', () => {
    const agent = t.db.agents.create({ name: 'Minimal', systemPrompt: 'Be brief.' });
    expect(agent.description).toBe('');
    expect(agent.providerId).toBeNull();
    expect(agent.modelId).toBeNull();
    expect(agent.params).toEqual({});
  });

  it('rejects an agent without a name', () => {
    expect(() => t.db.agents.create({ name: '   ', systemPrompt: 'x' })).toThrow(DbError);
  });

  it('updates an agent and keeps fields the input omits', () => {
    const created = t.db.agents.create({
      name: 'Writer',
      description: 'Writes prose',
      providerId: 'provider-1',
      modelId: 'gpt-4o',
      systemPrompt: 'Write well.',
      params: { topP: 0.9 },
    });

    const updated = t.db.agents.update(created.id, {
      name: 'Writer v2',
      systemPrompt: 'Write very well.',
    });

    expect(updated.name).toBe('Writer v2');
    expect(updated.description).toBe('Writes prose');
    expect(updated.providerId).toBe('provider-1');
    expect(updated.modelId).toBe('gpt-4o');
    expect(updated.systemPrompt).toBe('Write very well.');
    expect(updated.params).toEqual({ topP: 0.9 });
    expect(rawAgent(created.id)?.version).toBe(2);
  });

  it('rejects an update for an unknown agent', () => {
    expect(() => t.db.agents.update('missing', { name: 'x', systemPrompt: 'y' })).toThrow(DbError);
  });

  it('duplicates an agent as an independent copy', () => {
    const source = t.db.agents.create({
      name: 'Researcher',
      description: 'Finds sources',
      systemPrompt: 'Cite everything.',
      params: { temperature: 0.4 },
    });

    const copy = t.db.agents.duplicate(source.id);

    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe('Researcher (copy)');
    expect(copy.description).toBe('Finds sources');
    expect(copy.systemPrompt).toBe('Cite everything.');
    expect(copy.params).toEqual({ temperature: 0.4 });
    expect(t.db.agents.count()).toBe(2);

    t.db.agents.update(copy.id, { name: 'Renamed copy', systemPrompt: 'Cite everything.' });
    expect(t.db.agents.get(source.id)?.name).toBe('Researcher');
  });

  it('rejects duplicating an unknown agent', () => {
    expect(() => t.db.agents.duplicate('missing')).toThrow(DbError);
  });

  it('soft deletes and hides an agent while keeping the tombstone', () => {
    const agent = t.db.agents.create({ name: 'Temporary', systemPrompt: 'x' });

    t.db.agents.softDelete(agent.id);

    expect(t.db.agents.get(agent.id)).toBeNull();
    expect(t.db.agents.list()).toEqual([]);
    expect(t.db.agents.count()).toBe(0);
    expect(rawAgent(agent.id)?.deleted_at).not.toBeNull();
    expect(rawAgent(agent.id)?.dirty).toBe(1);
  });

  it('orders the list by name', () => {
    t.db.agents.create({ name: 'zeta', systemPrompt: 'x' });
    t.db.agents.create({ name: 'Alpha', systemPrompt: 'x' });
    expect(t.db.agents.list().map((agent) => agent.name)).toEqual(['Alpha', 'zeta']);
  });
});
