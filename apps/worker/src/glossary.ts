import { z } from 'zod';
import { applyGlossary } from '../../../packages/core/src/glossary/apply.js';
import {
  emptyGlossary,
  glossaryInputSchema,
  glossaryLangSchema,
  type Glossary,
} from '../../../packages/core/src/glossary/schema.js';
import { blobSha, RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { permissions, requireAccess } from './permissions.js';
import type { Identity } from './types.js';

export async function glossaryRoute(
  request: Request,
  github: GitHub,
  user: Identity,
  rawLang: string,
) {
  const parsed = glossaryLangSchema.safeParse(rawLang);
  if (!parsed.success) throw new HttpError(400, 'Invalid glossary language');
  const lang = parsed.data;
  if (github.env.DATA_BRANCH !== 'editor-data')
    throw new HttpError(503, 'Glossary destination is not configured');
  const path = `glossary/${lang}.json`;
  const write = request.method === 'POST';
  // Authorize before reading the request body, and reauthorize at every ref retry.
  let input: z.infer<typeof glossaryInputSchema> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github.head();
    const access = requireAccess(await permissions(github, head), user, [
      'maintainer',
      'translator',
      'editor',
      'trial',
    ]);
    if (
      write &&
      access.role !== 'maintainer' &&
      !(access.role === 'translator' && access.languages?.includes(lang))
    )
      throw new HttpError(
        403,
        'Only this language’s translators and maintainers may edit its glossary',
      );
    const file = await github.file(path, head);
    // GET forwards the stored document; the client validates what it renders.
    if (!write)
      return json({ revision: file?.sha ?? null, glossary: file?.value ?? emptyGlossary(lang) });
    const current = (file?.value ?? emptyGlossary(lang)) as Glossary;
    if (
      !current ||
      current.v !== 1 ||
      current.lang !== lang ||
      !current.terms ||
      typeof current.terms !== 'object' ||
      Array.isArray(current.terms)
    )
      throw new HttpError(502, 'Invalid stored glossary');
    input ??= await body(request, glossaryInputSchema, 100_000);
    let applied;
    try {
      applied = applyGlossary(current, input.ops, new Date().toISOString(), user.login);
    } catch (error) {
      if (error instanceof RangeError) throw new HttpError(400, error.message);
      if (error instanceof z.ZodError) throw new HttpError(400, 'Invalid glossary', error.issues);
      throw error;
    }
    if (applied.conflicts.length) return json({ conflicts: applied.conflicts }, 409);
    const glossary = applied.glossary;
    // Native pretty JSON with stable object-key order, serialized once and committed as-is.
    const content = `${JSON.stringify(
      glossary,
      (_key, value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : value,
      2,
    )}\n`;
    try {
      const commit = await github.commit(
        head,
        {},
        `Glossary ${lang}: ${input.ops.map((op) => `${op.next ? 'set' : 'remove'} ${JSON.stringify(op.next?.en ?? op.base?.en ?? op.key)}`).join(', ')}`,
        user,
        { rawFiles: { [path]: content } },
      );
      return json({
        commit,
        revision: await blobSha(content),
        glossary,
      });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  return json({ error: 'Glossary changed; retry the save' }, 409);
}
