import { z } from 'zod';
import {
  langSchema,
  permissionsSchema,
  stableStringify,
  tooltipSchema,
  type Lang,
  type LangText,
  type Permissions,
  type Tooltip,
} from '@clarity/core';
import { RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { keepsTranslationRevision, managedLanguages, type Access } from './permissions.js';
import { saveChanges } from './save.js';
import type { Identity } from './types.js';

/**
 * Translation managers (PRODUCT "Translation managers"): a translator with `manages: [lang]`.
 * - /translators/:lang: list, add, and remove translators of a managed language. A manager
 *   changes only that language of plain translators (never other roles, other managers, other
 *   languages, or themselves); removing a translator's last language removes the account.
 * - /rollback/upload: revert one person's /save commit in one non-English language (managers in
 *   their languages, maintainers in any), as a new save. Perks a later commit changed in that
 *   language are skipped and listed for per-perk Restore in History.
 */

const permissionsPath = 'config/permissions.json';
const loginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, 'Invalid GitHub login');
const translationLang = (raw: string): Lang => {
  const lang = langSchema.safeParse(raw);
  if (!lang.success || lang.data === 'en') throw new HttpError(400, 'Invalid translation language');
  return lang.data;
};

function requireManager(config: Permissions, user: Identity, lang: Lang): void {
  if (!managedLanguages(config.users[String(user.id)]).includes(lang))
    throw new HttpError(403, `Only ${lang} translation managers can do this`);
}

function translatorsOf(config: Permissions, lang: Lang) {
  return Object.entries(config.users)
    .filter(([, access]) => access.role === 'translator' && access.languages?.includes(lang))
    .map(([id, access]) => ({
      id: Number(id),
      login: access.login,
      languages: access.languages ?? [],
      manager: managedLanguages(access).length > 0,
    }))
    .sort((a, b) => a.login.localeCompare(b.login));
}

/** The one access a manager may change: a plain translator (no other role, not a manager). */
function changeable(config: Permissions, user: Identity, id: number): Access | undefined {
  if (id === user.id) throw new HttpError(403, 'Managers cannot change their own access');
  if (config.partners?.[String(id)])
    throw new HttpError(403, 'Managers can change only translators');
  const access = config.users[String(id)];
  if (access && (access.role !== 'translator' || managedLanguages(access).length))
    throw new HttpError(403, 'Managers can change only translators');
  return access;
}

export async function translatorsRoute(
  request: Request,
  github: GitHub,
  user: Identity,
  rawLang: string,
  rawId: string | undefined,
): Promise<Response> {
  const lang = translationLang(rawLang);
  const method = request.method;
  // GET and POST /translators/:lang; DELETE /translators/:lang/:id.
  if ((method === 'DELETE') !== (rawId !== undefined))
    throw new HttpError(404, 'Endpoint not found');
  const add =
    method === 'POST' ? await body(request, z.object({ login: loginSchema }).strict()) : null;
  const removeId = rawId === undefined ? undefined : Number(rawId);
  if (rawId !== undefined && !(/^[1-9]\d*$/.test(rawId) && Number.isSafeInteger(removeId)))
    throw new HttpError(400, 'Invalid account id');
  // Resolved once, before the CAS loop: the account itself does not change between attempts.
  let account: { id: number; login: string } | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github.head();
    const config = permissionsSchema.parse(
      (await github.requiredFile(permissionsPath, head)).value,
    );
    requireManager(config, user, lang);
    if (method === 'GET') return json({ lang, translators: translatorsOf(config, lang) });
    const users = { ...config.users };
    let message: string;
    if (add) {
      account ??= await github.account(add.login);
      const access = changeable(config, user, account.id);
      if (access?.languages?.includes(lang))
        return json({ lang, translators: translatorsOf(config, lang) });
      users[String(account.id)] = {
        login: account.login,
        role: 'translator',
        languages: [...(access?.languages ?? []), lang],
      };
      message = `Add ${account.login} as ${lang} translator by ${user.login}`;
    } else {
      const access = changeable(config, user, removeId!);
      if (!access?.languages?.includes(lang))
        throw new HttpError(404, `That account is not a ${lang} translator`);
      const languages = access.languages.filter((value) => value !== lang);
      if (languages.length) users[String(removeId)] = { ...access, languages };
      else delete users[String(removeId)];
      message = `Remove ${access.login} as ${lang} translator by ${user.login}`;
    }
    const next = permissionsSchema.parse({ ...config, users });
    try {
      const commit = await github.commit(head, { [permissionsPath]: next }, message, user);
      return json({ commit, lang, translators: translatorsOf(next, lang) });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload and retry');
}

const rollbackSchema = z
  .object({ commit: z.string().regex(/^[0-9a-f]{40}$/), lang: z.string() })
  .strict();
const gitCommitSchema = z.object({
  message: z.string(),
  parents: z.array(z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) })),
});
const compareSchema = z.object({ status: z.string() });
export type SkipReason = 'changed-later' | 'deleted';

/** The tooltips a /save commit changed in `lang`, from its Clarity-Changed trailer (hints only). */
export function trailerHashes(message: string, lang: Lang): number[] | null {
  const line = message.split('\n').find((value) => value.startsWith('Clarity-Changed: '));
  if (!line) return null;
  const hashes: number[] = [];
  for (const part of line.slice('Clarity-Changed: '.length).split(';')) {
    const [hash, fields = ''] = part.split('=');
    if (/^(0|[1-9]\d*)$/.test(hash ?? '') && fields.split(',').includes(lang))
      hashes.push(Number(hash));
  }
  return hashes;
}

/**
 * A rolled-back translation (root ruling 2026-11-16): the old text, revised now by the person
 * rolling back, still translating the English it was written against (its own source, else that
 * revision's English), so outdated status and the 90-day fallback stay honest. Same or
 * markup-only text keeps the current stamps, as every save must.
 */
export function rolledBack(
  current: Tooltip,
  lang: Lang,
  old: Tooltip | null,
  login: string,
  now: string,
): Tooltip {
  const next = structuredClone(current);
  const entry = old?.text[lang];
  if (!entry) {
    delete next.text[lang];
    return next;
  }
  if (keepsTranslationRevision(current, lang, entry.text)) {
    next.text[lang] = { ...current.text[lang]!, text: entry.text };
    return next;
  }
  const source = entry.sourceUpdatedAt ?? old.text.en?.updatedAt;
  const restored: LangText = {
    text: entry.text,
    updatedAt: now,
    updatedBy: login,
    ...(source ? { sourceUpdatedAt: source } : {}),
  };
  next.text[lang] = restored;
  return next;
}

export async function rollbackUpload(
  request: Request,
  github: GitHub,
  user: Identity,
): Promise<Response> {
  const apply = request.method === 'POST';
  const url = new URL(request.url);
  const query = rollbackSchema.safeParse({
    commit: url.searchParams.get('commit') ?? '',
    lang: url.searchParams.get('lang') ?? '',
  });
  if (!apply && !query.success) throw new HttpError(400, 'Invalid request', query.error.issues);
  const input = apply ? await body(request, rollbackSchema) : query.data!;
  const lang = translationLang(input.lang);
  const authorize = (access: Access | undefined) => {
    if (access?.role !== 'maintainer' && !managedLanguages(access).includes(lang))
      throw new HttpError(403, `Only maintainers and ${lang} translation managers can roll back`);
  };
  const head = await github.head();
  const config = permissionsSchema.parse((await github.requiredFile(permissionsPath, head)).value);
  authorize(config.users[String(user.id)]);
  const read = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    const response = await github.request(path);
    if (response.status === 404 || response.status === 422)
      throw new HttpError(404, 'Commit not found');
    if (!response.ok) throw new HttpError(502, `GitHub request failed (${response.status})`);
    return schema.parse(await response.json());
  };
  const [upload, ancestry] = await Promise.all([
    read(`/git/commits/${input.commit}`, gitCommitSchema),
    read(`/compare/${head}...${input.commit}?per_page=1`, compareSchema),
  ]);
  if (!['behind', 'identical'].includes(ancestry.status))
    throw new HttpError(422, 'That commit is not part of the editor data history');
  const hashes = trailerHashes(upload.message, lang);
  // Owner 2026-11-16 "Saves by people (Rec.)": only /save commits are uploads.
  if (!hashes || upload.parents.length !== 1)
    throw new HttpError(422, 'Only uploads (saves by people) can be rolled back as a whole');
  const parent = upload.parents[0]!.sha;
  const files = await github.blobs(
    hashes.flatMap((hash) =>
      [parent, input.commit, head].map((ref) => ({ ref, path: `tooltips/${hash}.json` })),
    ),
  );
  const parse = (file: { value: unknown } | null, hash: number) => {
    if (!file) return null;
    const tooltip = tooltipSchema.parse(file.value);
    if (tooltip.hash !== hash) throw new HttpError(502, 'Stored tooltip hash mismatch');
    return tooltip;
  };
  const now = new Date().toISOString();
  const changes: { hash: number; base: Tooltip; next: Tooltip }[] = [];
  const skipped: { hash: number; reason: SkipReason }[] = [];
  for (const [index, hash] of hashes.entries()) {
    const before = parse(files[index * 3]!, hash);
    const after = parse(files[index * 3 + 1]!, hash);
    const current = parse(files[index * 3 + 2]!, hash);
    const entry = (tooltip: Tooltip | null) => stableStringify(tooltip?.text[lang] ?? null);
    if (entry(before) === entry(after)) continue;
    if (!current) skipped.push({ hash, reason: 'deleted' });
    else if (entry(current) !== entry(after)) skipped.push({ hash, reason: 'changed-later' });
    else {
      const next = rolledBack(current, lang, before, user.login, now);
      if (entry(next) !== entry(current)) changes.push({ hash, base: current, next });
    }
  }
  const plan = { upload: input.commit, lang, reverted: changes.map(({ hash }) => hash), skipped };
  if (!apply) return json(plan);
  if (!changes.length) throw new HttpError(409, 'Nothing in this upload can be rolled back', plan);
  const result = await saveChanges(
    github,
    user,
    {
      changes,
      message: `Roll back ${lang} of upload ${input.commit.slice(0, 8)} by ${user.login}`,
    },
    authorize,
  );
  return 'conflicts' in result ? json(result, 409) : json({ ...result, ...plan });
}
