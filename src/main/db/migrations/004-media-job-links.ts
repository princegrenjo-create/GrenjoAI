/**
 * Schema version 4 — where a job's result belongs, and what it was given.
 *
 * Three additive columns on `generation_jobs`, no change to any other table:
 *
 *  - `reference_ids` — the media rows a job was given as references, as a JSON
 *    array of ids. Ids, not bytes: the row stays small and the bytes stay in the
 *    store, so a resumed job can read the same references back after a restart.
 *  - `conversation_id` / `message_id` — the conversation the result belongs to,
 *    and `mask_media_id` for a provider that takes an inpainting mask,
 *    recorded on the job so an interrupted generation still knows where its image
 *    goes when it finishes. Without them a result that completes after a restart
 *    would be orphaned in the library with no link back to the chat that asked.
 *
 * Foreign keys are `ON DELETE SET NULL` for the same reason as in schema 3: deleting
 * a conversation must not delete a job's record of what it was asked to make.
 *
 * SQLite cannot add a column with a foreign key in `ALTER TABLE`, so the two links
 * are plain columns here; the media row they end up on carries the enforced
 * constraint, and this table is the job's own log, not the association.
 *
 * Consequence: after this ships the previous build refuses the database (the runner
 * will not open a newer schema). No downgrade path, as with migration 3.
 */
export const MEDIA_JOB_LINKS_SQL = `
ALTER TABLE generation_jobs ADD COLUMN reference_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE generation_jobs ADD COLUMN conversation_id TEXT NULL;
ALTER TABLE generation_jobs ADD COLUMN message_id TEXT NULL;
ALTER TABLE generation_jobs ADD COLUMN mask_media_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_conversation ON generation_jobs (conversation_id);
`;
