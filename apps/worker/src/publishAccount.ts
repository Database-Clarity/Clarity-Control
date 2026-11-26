import { z } from 'zod';
import { publishAccountPath, publishOpIdSchema, readPublishAccount } from '@clarity/core';
import type { GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { settingsFileId } from './settings.js';
import type { Identity } from './types.js';

const ackSchema = z.object({ opId: publishOpIdSchema }).strict();
/** Acknowledgments outlive the 50-entry account index by far; older ones are pruned on write. */
const ackRetentionMs = 180 * 86_400_000;

/**
 * GET /publish/mine: the signed-in account's own publish index (counts and statuses, never tooltip
 * text) and which of its publishes it acknowledged. Any signed-in account may read its own index,
 * including one whose role changed since it published. `acknowledged` is null when the settings
 * database cannot be read: the web then shows every notice the index asks for (fail open).
 */
export async function publishMine(github: GitHub, user: Identity) {
  const path = publishAccountPath(user.id);
  const snapshot = await github.publishSnapshot([path]);
  const { entries } = readPublishAccount(snapshot.files[0]?.value);
  let acknowledged: string[] | null = null;
  try {
    const db = github.env.SETTINGS_DB;
    if (db) {
      const account = await settingsFileId(github.env.SESSION_SECRET, user.id);
      const row = await db
        .prepare('SELECT json_group_array(op_id) AS ids FROM publish_acks WHERE account_id = ?')
        .bind(account)
        .first<{ ids: string }>();
      const ids = z.array(publishOpIdSchema).safeParse(JSON.parse(row?.ids ?? '[]'));
      if (ids.success) {
        const listed = new Set(entries.map(({ opId }) => opId));
        acknowledged = ids.data.filter((id) => listed.has(id));
      }
    }
  } catch {
    acknowledged = null;
  }
  return json({ entries, acknowledged });
}

/** POST /publish/ack `{ opId }`: this account has seen that publish's outcome, on every device. */
export async function publishAck(request: Request, github: GitHub, user: Identity) {
  const { opId } = await body(request, ackSchema, 1024);
  const db = github.env.SETTINGS_DB;
  if (!db) throw new HttpError(503, 'Settings are unavailable');
  const account = await settingsFileId(github.env.SESSION_SECRET, user.id);
  const now = Date.now();
  await db
    .prepare('DELETE FROM publish_acks WHERE account_id = ? AND acked_at < ?')
    .bind(account, now - ackRetentionMs)
    .run();
  await db
    .prepare(
      'INSERT INTO publish_acks (account_id, op_id, acked_at) VALUES (?, ?, ?) ON CONFLICT(account_id, op_id) DO NOTHING',
    )
    .bind(account, opId, now)
    .run();
  return json({ opId, acknowledged: true });
}
