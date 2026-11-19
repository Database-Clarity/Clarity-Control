import { z } from 'zod';
import { languages, type Lang } from '../../../../packages/core/src/languageCodes';
import { tooltipSchema } from '../../../../packages/core/src/schemas';
import { apiRequest } from './apiAuth';
import { requestError } from './httpError';

/** Translation managers (PRODUCT "Translation managers"): the Worker's /translators and /rollback. */

async function result<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  // The Worker's error sentence, or the status; never an HTML or JSON body (kept on `cause`).
  if (!response.ok)
    throw requestError('Translation managers request', response.status, await response.text());
  return schema.parse(await response.json());
}

const translatorSchema = z.object({
  id: z.number(),
  login: z.string(),
  languages: z.array(z.enum(languages)),
  manager: z.boolean(),
});
export type Translator = z.infer<typeof translatorSchema>;
const translatorsSchema = z.object({ translators: z.array(translatorSchema) });

export async function getTranslators(lang: Lang, signal?: AbortSignal): Promise<Translator[]> {
  return (await result(await apiRequest(`/translators/${lang}`, { signal }), translatorsSchema))
    .translators;
}

export async function addTranslator(lang: Lang, login: string): Promise<Translator[]> {
  const response = await apiRequest(`/translators/${lang}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: login.trim() }),
  });
  return (await result(response, translatorsSchema)).translators;
}

export async function removeTranslator(lang: Lang, id: number): Promise<Translator[]> {
  const response = await apiRequest(`/translators/${lang}/${id}`, { method: 'DELETE' });
  return (await result(response, translatorsSchema)).translators;
}

const planSchema = z.object({
  upload: z.string(),
  lang: z.enum(languages),
  reverted: z.array(z.number()),
  skipped: z.array(z.object({ hash: z.number(), reason: z.enum(['changed-later', 'deleted']) })),
});
export type RollbackPlan = z.infer<typeof planSchema>;

/** What rolling back `lang` of upload `commit` would revert and skip; writes nothing. */
export async function getRollbackPlan(
  commit: string,
  lang: Lang,
  signal?: AbortSignal,
): Promise<RollbackPlan> {
  const query = new URLSearchParams({ commit, lang });
  return result(await apiRequest(`/rollback/upload?${query}`, { signal }), planSchema);
}

const appliedSchema = planSchema.extend({
  /** The new rollback commit. */
  commit: z.string(),
  tooltips: z.array(tooltipSchema),
  savedAt: z.number().optional(),
});
export type RollbackResult = z.infer<typeof appliedSchema>;

export async function applyRollback(commit: string, lang: Lang): Promise<RollbackResult> {
  const response = await apiRequest('/rollback/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commit, lang }),
  });
  return result(response, appliedSchema);
}
