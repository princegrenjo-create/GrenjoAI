/**
 * Agent repository.
 *
 * An agent is a reusable persona: a name, a system prompt and optionally a
 * bound provider/model plus generation parameters. It carries the sync header
 * because agents are user data that must survive a reinstall and sync between
 * devices.
 */
import type { AgentRepository, WriteOptions } from '../../../shared/repository-contract';
import type { Agent, AgentInput, Id } from '../../../shared/types';
import { jsonOrNull, newId, nowIso, type DbRow } from '../codec';
import { DbError } from '../errors';
import { toAgent } from '../rows';
import { BaseRepository, dirtyFlag } from './base';

const AGENT_COLUMNS = `a.*,
  (SELECT COUNT(*) FROM sync_conflicts sc
     WHERE sc.entity = 'agent' AND sc.entity_id = a.id AND sc.resolution = 'unresolved') AS has_conflict`;

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new DbError('An agent needs a name.', 'validation');
  }
  return trimmed;
}

export class SqliteAgentRepository extends BaseRepository implements AgentRepository {
  list(): Agent[] {
    const rows = this.sql.query<DbRow>(
      `SELECT ${AGENT_COLUMNS}
         FROM agents a
        WHERE a.deleted_at IS NULL
        ORDER BY a.name COLLATE NOCASE ASC, a.created_at ASC`,
    );
    return rows.map((row) => toAgent(row));
  }

  get(id: Id): Agent | null {
    const row = this.sql.get<DbRow>(
      `SELECT ${AGENT_COLUMNS} FROM agents a WHERE a.id = ? AND a.deleted_at IS NULL`,
      [id],
    );
    return row === null ? null : toAgent(row);
  }

  create(input: AgentInput, options?: WriteOptions): Agent {
    const id = input.id !== undefined && input.id.trim().length > 0 ? input.id : newId();
    const now = nowIso();
    this.sql.run(
      `INSERT INTO agents
         (id, name, description, provider_id, model_id, system_prompt, params_json,
          version, dirty, attempts, next_attempt_at, last_error, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, NULL, NULL, ?, ?, NULL)`,
      [
        id,
        requireName(input.name),
        input.description ?? '',
        input.providerId ?? null,
        input.modelId ?? null,
        input.systemPrompt,
        jsonOrNull(input.params ?? {}),
        dirtyFlag(options),
        now,
        now,
      ],
    );
    return this.require(id);
  }

  update(id: Id, input: AgentInput, options?: WriteOptions): Agent {
    const current = this.require(id);
    const name = requireName(input.name);
    const description = input.description ?? current.description;
    const providerId = input.providerId !== undefined ? input.providerId : current.providerId;
    const modelId = input.modelId !== undefined ? input.modelId : current.modelId;
    const params = input.params !== undefined ? input.params : current.params;

    this.sql.run(
      `UPDATE agents
          SET name = ?, description = ?, provider_id = ?, model_id = ?, system_prompt = ?,
              params_json = ?, version = version + 1, updated_at = ?, dirty = ?
        WHERE id = ?`,
      [
        name,
        description,
        providerId,
        modelId,
        input.systemPrompt,
        jsonOrNull(params),
        nowIso(),
        dirtyFlag(options),
        id,
      ],
    );
    return this.require(id);
  }

  duplicate(id: Id): Agent {
    const source = this.require(id);
    return this.create({
      name: `${source.name} (copy)`,
      description: source.description,
      providerId: source.providerId,
      modelId: source.modelId,
      systemPrompt: source.systemPrompt,
      params: source.params,
    });
  }

  softDelete(id: Id, options?: WriteOptions): void {
    const now = nowIso();
    this.sql.run(
      `UPDATE agents
          SET deleted_at = ?, version = version + 1, updated_at = ?, dirty = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [now, now, dirtyFlag(options), id],
    );
  }

  count(): number {
    const row = this.sql.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agents WHERE deleted_at IS NULL',
    );
    return row === null ? 0 : row.n;
  }

  private require(id: Id): Agent {
    const agent = this.get(id);
    if (agent === null) {
      throw new DbError(`Agent ${id} does not exist.`, 'not_found');
    }
    return agent;
  }
}
