/**
 * Migration 2 — attachment metadata on messages.
 *
 * Additive and forward-only. `attachments` holds a JSON array of
 * `MessageAttachment` (name, type, size, extraction status) — never file bytes
 * and never a filesystem path, so the database stays small and moving the profile
 * folder stays safe. Messages written before this migration read back as `[]`.
 *
 * One statement, no transaction: the migration runner wraps each migration in its
 * own savepoint, so a failure rolls the column addition back completely.
 */
export const MESSAGE_ATTACHMENTS_SQL = `ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';`;
