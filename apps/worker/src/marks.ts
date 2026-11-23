import { permissionsSchema } from '@clarity/core';
import {
  emptyMarks,
  marksPath,
  marksStructureSchema,
  maxEntryMarks,
  maxMarkedEntries,
  maxMarksBytes,
  type Marks,
  updateMarksSchema,
} from '@clarity/core/marks';
import { blobContent, blobSha, RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { requireAccess } from './permissions.js';
import type { Identity } from './types.js';

/** Values that are not even shaped like marks fail reads closed until the file is repaired. */
function shapedLikeMarks(value: unknown) {
  const marks = value as { types?: unknown; entries?: unknown };
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray(marks.types) &&
    typeof marks.entries === 'object' &&
    marks.entries !== null &&
    !Array.isArray(marks.entries)
  );
}

/**
 * The document-wide limits on a change: one pass over the types and the entries, never another
 * whole-document parse. Every other invariant holds by construction of the bounded change above.
 */
function assertMarksCaps(marks: Marks) {
  if (marks.types.length > 32) throw new HttpError(400, 'Too many mark types');
  const ids = new Set(marks.types.map((type) => type.id));
  if (ids.size !== marks.types.length) throw new HttpError(400, 'Duplicate mark type IDs');
  const labels = new Set(marks.types.map((type) => type.label.toLowerCase()));
  if (labels.size !== marks.types.length) throw new HttpError(400, 'Duplicate mark type labels');
  let count = 0;
  for (const entries of Object.values(marks.entries)) count += entries.length;
  if (count > maxEntryMarks)
    throw new HttpError(400, `Too many entry marks (maximum ${maxEntryMarks})`);
  if (Object.keys(marks.entries).length > maxMarkedEntries)
    throw new HttpError(400, 'Too many marked entries');
}

/** One bounded change, whole-file CAS, and current permissions on every ref-race retry. */
export async function marksRoute(request: Request, github: GitHub, user: Identity) {
  let invalid: unknown;
  const input =
    request.method === 'PUT'
      ? await body(request, updateMarksSchema, 4096).catch((error: unknown) => {
          invalid = error;
          return null;
        })
      : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github.head();
    const [permissions, file] = await github.files(['config/permissions.json', marksPath], head);
    if (!permissions) throw new HttpError(502, 'Required repository file is missing');
    const access = requireAccess(
      permissionsSchema.parse(permissions.value),
      user,
      request.method === 'GET'
        ? ['maintainer', 'editor', 'trial', 'translator']
        : ['maintainer', 'editor'],
    );
    if (invalid) throw invalid;
    const decision =
      input?.change.action === 'compendium-set' || input?.change.action === 'compendium-clear'
        ? input.change
        : null;
    if (decision) {
      if (access.role !== 'maintainer')
        throw new HttpError(403, 'Only maintainers can manage Compendium decisions');
      if (github.env.COMPENDIUM_DECISION_WRITES !== '1')
        throw new HttpError(503, 'Compendium decision writes are disabled');
    } else if (input && input.change.action.endsWith('-type') && access.role !== 'maintainer')
      throw new HttpError(403, 'Only maintainers can manage mark types');
    // A read hands the stored file to the store, which validates it; only a value that is not
    // marks-shaped at all is refused here.
    if (!input) {
      if (file && !shapedLikeMarks(file.value))
        throw new HttpError(502, `Invalid ${marksPath}; marks are read-only until repaired`);
      return json({ marks: file ? file.value : emptyMarks(), revision: file?.sha ?? null });
    }
    // A write validates the stored document once, then checks the byte cap on the string it
    // commits: no second whole-document parse, and no repeated serialisation or encoding.
    const stored = marksStructureSchema.safeParse(file ? file.value : emptyMarks());
    if (!stored.success)
      throw new HttpError(502, `Invalid ${marksPath}; marks are read-only until repaired`);
    const marks = stored.data;
    const revision = file?.sha ?? null;
    if (input.revision !== revision)
      throw new HttpError(409, 'Marks changed since they were loaded; reload and retry');
    const change = input.change;
    const stamp = { by: user.id, at: new Date().toISOString() };
    if (change.action === 'compendium-set' || change.action === 'compendium-clear') {
      // The editor sends canonical hashes for new decisions and stored keys for clears.
      const decisions = (marks.compendium ??= {});
      let changed = false;
      for (const hash of change.hashes) {
        if (change.action === 'compendium-set') {
          if (decisions[hash]?.kind === change.kind) continue;
          decisions[hash] = { kind: change.kind, ...stamp };
        } else {
          if (!Object.hasOwn(decisions, hash)) continue;
          delete decisions[hash];
        }
        changed = true;
      }
      if (!changed) return json({ commit: null, marks: file?.value ?? emptyMarks(), revision });
      if (change.action === 'compendium-clear' && !Object.keys(decisions).length)
        delete marks.compendium;
    } else if (change.action === 'mark' || change.action === 'unmark') {
      if (!marks.types.some((type) => type.id === change.type))
        throw new HttpError(409, 'This mark type no longer exists; reload marks');
      const entries = (marks.entries[change.hash] ?? []).filter(
        (mark) => mark.type !== change.type,
      );
      if (change.action === 'mark')
        entries.push({
          type: change.type,
          ...stamp,
          ...(change.note ? { note: change.note } : {}),
        });
      if (entries.length) marks.entries[change.hash] = entries;
      else delete marks.entries[change.hash];
    } else if (change.action === 'create-type') {
      if (marks.types.some((type) => type.id === change.id))
        throw new HttpError(409, 'This mark type already exists; reload marks');
      marks.types.push({ id: change.id, label: change.label, colour: change.colour, ...stamp });
    } else {
      const type = marks.types.find((type) => type.id === change.id);
      if (!type) throw new HttpError(409, 'This mark type no longer exists; reload marks');
      if (change.action === 'edit-type') {
        type.label = change.label;
        type.colour = change.colour;
      } else {
        const used = Object.values(marks.entries).some((entries) =>
          entries.some((mark) => mark.type === change.id),
        );
        if (used && !change.force)
          throw new HttpError(
            409,
            'This type is in use; confirm removal of the type and all its marks',
          );
        marks.types = marks.types.filter((type) => type.id !== change.id);
        for (const [hash, entries] of Object.entries(marks.entries)) {
          const kept = entries.filter((mark) => mark.type !== change.id);
          if (kept.length) marks.entries[hash] = kept;
          else delete marks.entries[hash];
        }
      }
    }
    const content = blobContent(marks);
    // The shared schema bounds total UTF-8 bytes, including multibyte notes; the committed string
    // is the one string checked here.
    if (new TextEncoder().encode(content).length > maxMarksBytes)
      throw new HttpError(
        400,
        `Entry marks and Compendium decisions share a ${maxMarksBytes.toLocaleString('en-US')}-byte file limit. This change would exceed it.`,
      );
    assertMarksCaps(marks);
    try {
      const commit = await github.commit(
        head,
        {},
        `Update ${decision ? 'Compendium decisions' : 'entry marks'} by ${user.login}`,
        user,
        { rawFiles: { [marksPath]: content } },
      );
      return json({ commit, marks, revision: await blobSha(content) });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload marks and retry');
}
