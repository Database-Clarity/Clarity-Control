import { permissionsSchema } from '@clarity/core';
import { emptyMarks, marksPath, marksSchema, updateMarksSchema } from '@clarity/core/marks';
import { blobContent, blobSha, RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { requireAccess } from './permissions.js';
import type { Identity } from './types.js';

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
    if (input && input.change.action.endsWith('-type') && access.role !== 'maintainer')
      throw new HttpError(403, 'Only maintainers can manage mark types');
    const stored = marksSchema.safeParse(file ? file.value : emptyMarks());
    if (!stored.success)
      throw new HttpError(502, `Invalid ${marksPath}; marks are read-only until repaired`);
    const marks = stored.data;
    const revision = file?.sha ?? null;
    if (!input) return json({ marks, revision });
    if (input.revision !== revision)
      throw new HttpError(409, 'Marks changed since they were loaded; reload and retry');
    const change = input.change;
    const stamp = { by: user.id, at: new Date().toISOString() };
    if (change.action === 'mark' || change.action === 'unmark') {
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
    const checked = marksSchema.safeParse(marks);
    if (!checked.success)
      throw new HttpError(
        400,
        checked.error.issues[0]?.message ?? 'Invalid marks',
        checked.error.issues,
      );
    // The shared schema bounds total UTF-8 bytes, including multibyte notes.
    const content = blobContent(checked.data);
    try {
      const commit = await github.commit(
        head,
        { [marksPath]: checked.data },
        `Update entry marks by ${user.login}`,
        user,
      );
      return json({ commit, marks: checked.data, revision: await blobSha(content) });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload marks and retry');
}
