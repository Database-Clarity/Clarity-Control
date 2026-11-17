import { z } from 'zod';
import { stableStringify } from '@clarity/core';
import {
  personalSnippetIdSchema,
  personalSnippetSchema,
  storedPersonalSnippetSchema,
  storedTeamSnippetSchema,
  teamSnippetIdSchema,
  teamSnippetSchema,
  snippetChangeSchema,
  emptyTeamSnippets,
  teamSnippetsSchema,
  snippetsPath,
  type CustomSnippet,
} from '../../../packages/core/src/customSnippets.js';
import {
  snippetsAccountId,
  snippetsLabelId,
  snippetsKey,
  encryptSnippet,
  decryptSnippet,
} from './snippetCrypto.js';
import { RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import type { Identity } from './types.js';

const revisionSchema = z.string().regex(/^[0-9a-f]{32}$/);
const personalWriteSchema = z
  .object({ snippet: personalSnippetSchema.nullable(), revision: revisionSchema.nullable() })
  .strict();
const encryptedPlainSchema = z
  .object({ snippet: storedPersonalSnippetSchema, revision: revisionSchema })
  .strict();
interface Row {
  id: string;
  iv: string;
  ct: string;
  revision: string;
}

export async function readPersonalSnippet(github: GitHub, user: Identity, id: string) {
  const db = github.env.SETTINGS_DB;
  if (!db) throw new HttpError(503, 'Snippets are unavailable');
  const account = await snippetsAccountId(github.env.SESSION_SECRET, user.id);
  const key = await snippetsKey(github.env.SESSION_SECRET);
  const row = await db
    .prepare('SELECT id, iv, ct, revision FROM user_snippets WHERE account_id = ? AND id = ?')
    .bind(account, id)
    .first<Row>();
  return { db, account, key, row, stored: await decode(row, account, key) };
}
async function decode(row: Row | null, account: string, key: CryptoKey) {
  if (!row) return { snippet: null, revision: null };
  const parsed = encryptedPlainSchema.safeParse(
    await decryptSnippet(key, `${account}:${row.id}`, row.iv, row.ct),
  );
  if (!parsed.success || parsed.data.revision !== row.revision || parsed.data.snippet.id !== row.id)
    throw new HttpError(503, 'Snippet could not be authenticated');
  return parsed.data;
}
export async function personalSnippetsRoute(
  request: Request,
  github: GitHub,
  user: Identity,
  id?: string,
) {
  requireAccess(await permissions(github, await github.head()), user, [
    'maintainer',
    'editor',
    'trial',
    'translator',
  ]);
  if (id === undefined) {
    if (request.method !== 'GET') throw new HttpError(405, 'Choose a snippet to save');
    const db = github.env.SETTINGS_DB;
    if (!db) throw new HttpError(503, 'Snippets are unavailable');
    const account = await snippetsAccountId(github.env.SESSION_SECRET, user.id);
    const key = await snippetsKey(github.env.SESSION_SECRET);
    const index = await db
      .prepare(
        "SELECT json_group_array(json_object('id', id, 'iv', iv, 'ct', ct, 'revision', revision)) AS rows FROM user_snippets WHERE account_id = ?",
      )
      .bind(account)
      .first<{ rows: string }>();
    const rows = JSON.parse(index?.rows ?? '[]') as Row[];
    return json({ snippets: await Promise.all(rows.map((row) => decode(row, account, key))) });
  }
  try {
    id = decodeURIComponent(id);
  } catch {
    throw new HttpError(400, 'Invalid personal snippet id');
  }
  if (!personalSnippetIdSchema.safeParse(id).success)
    throw new HttpError(400, 'Invalid personal snippet id');
  const input = request.method === 'PUT' ? await body(request, personalWriteSchema, 32_000) : null;
  if (input?.snippet && input.snippet.id !== id) throw new HttpError(400, 'Snippet ids must match');
  const { db, account, key, row, stored } = await readPersonalSnippet(github, user, id);
  if (request.method === 'GET') return json(stored);
  if (!input) throw new HttpError(405, 'Send a snippet operation');
  if (stored.revision !== input.revision)
    return json({ error: 'Snippet changed on another device', ...stored }, 409);
  if (!input.snippet) {
    if (!row) return json(stored);
    const result = await db
      .prepare(
        'DELETE FROM user_snippets WHERE account_id = ? AND id = ? AND revision = ? AND ct = ?',
      )
      .bind(account, id, row.revision, row.ct)
      .run();
    if (result.meta.changes === 1) return json({ snippet: null, revision: null });
  } else {
    if (stableStringify(stored.snippet) === stableStringify(input.snippet)) return json(stored);
    const revision = crypto.randomUUID().replaceAll('-', '');
    const labelId = await snippetsLabelId(github.env.SESSION_SECRET, account, input.snippet.label);
    const encrypted = await encryptSnippet(key, `${account}:${id}`, {
      snippet: input.snippet,
      revision,
    });
    const result = row
      ? await db
          .prepare(
            'UPDATE user_snippets SET iv = ?, ct = ?, revision = ?, label_id = ? WHERE account_id = ? AND id = ? AND revision = ? AND ct = ? AND NOT EXISTS (SELECT 1 FROM user_snippets WHERE account_id = ? AND label_id = ? AND id != ?)',
          )
          .bind(
            encrypted.iv,
            encrypted.ct,
            revision,
            labelId,
            account,
            id,
            row.revision,
            row.ct,
            account,
            labelId,
            id,
          )
          .run()
      : await db
          .prepare(
            'INSERT INTO user_snippets (account_id, id, iv, ct, revision, label_id) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM user_snippets WHERE account_id = ?) < 50 ON CONFLICT DO NOTHING',
          )
          .bind(account, id, encrypted.iv, encrypted.ct, revision, labelId, account)
          .run();
    if (result.meta.changes === 1) return json({ snippet: input.snippet, revision });
    const duplicate = await db
      .prepare('SELECT id FROM user_snippets WHERE account_id = ? AND label_id = ? AND id != ?')
      .bind(account, labelId, id)
      .first<{ id: string }>();
    if (duplicate) throw new HttpError(400, 'Duplicate personal snippet label');
    if (!row) {
      const current = await readPersonalSnippet(github, user, id);
      if (!current.row) throw new HttpError(400, 'An account can save up to 50 personal snippets');
    }
  }
  return json(
    {
      error: 'Snippet changed on another device',
      ...(await readPersonalSnippet(github, user, id)).stored,
    },
    409,
  );
}

const copySchema = z
  .object({
    sourceId: personalSnippetIdSchema,
    sourceRevision: revisionSchema,
    id: teamSnippetIdSchema,
    base: storedTeamSnippetSchema.nullable(),
  })
  .strict();
export async function teamSnippetsRoute(
  request: Request,
  github: GitHub,
  user: Identity,
  copy = false,
) {
  if (github.env.DATA_BRANCH !== 'editor-data')
    throw new HttpError(503, 'Snippet destination is not configured');
  let change: z.infer<typeof snippetChangeSchema> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github.head();
    requireAccess(
      await permissions(github, head),
      user,
      request.method === 'GET' ? ['maintainer', 'editor', 'trial', 'translator'] : ['maintainer'],
    );
    const file = await github.file(snippetsPath, head, request.method !== 'GET');
    // Reads need no repeated markup parsing of up to 100 templates. Clients validate the document.
    if (request.method === 'GET') return json({ team: file?.value ?? emptyTeamSnippets() });
    const parsed = teamSnippetsSchema.safeParse(file?.value ?? emptyTeamSnippets());
    if (!parsed.success)
      throw new HttpError(502, 'Invalid stored team snippets; repair before editing');
    if (!change) {
      if (copy) {
        const input = await body(request, copySchema, 32_000);
        const personal = (await readPersonalSnippet(github, user, input.sourceId)).stored;
        if (!personal.snippet || personal.revision !== input.sourceRevision)
          throw new HttpError(409, 'Personal snippet changed; reload before copying');
        change = { id: input.id, base: input.base, next: { ...personal.snippet, id: input.id } };
        const checked = teamSnippetSchema.safeParse(change.next);
        if (!checked.success)
          throw new HttpError(400, checked.error.issues[0]?.message ?? 'Invalid snippet');
        if (change.base && change.base.id !== change.id)
          throw new HttpError(400, 'Snippet ids must match');
      } else change = await body(request, snippetChangeSchema, 32_000);
    }
    const op = change;
    const current = parsed.data.snippets.find((s) => s.id === op.id) ?? null;
    if (stableStringify(current) !== stableStringify(change.base))
      return json(
        { error: 'Team snippet changed; reload and retry', id: change.id, head: current },
        409,
      );
    if (stableStringify(current) === stableStringify(change.next))
      return json({ team: parsed.data });
    const snippets: CustomSnippet[] = parsed.data.snippets.filter((s) => s.id !== op.id);
    const nextLabel = change.next?.label.toLowerCase();
    if (nextLabel && snippets.some((s) => s.label.toLowerCase() === nextLabel))
      throw new HttpError(400, 'Duplicate team snippet label');
    if (change.next) snippets.push(change.next);
    if (snippets.length > 100) throw new HttpError(400, 'The team can save up to 100 snippets');
    const team = { v: 1 as const, snippets };
    try {
      const commit = await github.commit(
        head,
        { [snippetsPath]: team },
        `Update team snippets by ${user.login}`,
        user,
      );
      return json({ commit, team });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload team snippets and retry');
}
