import { stableStringify } from '@clarity/core';
import {
  localizableBuiltIns,
  localizedSnippetLangSchema,
  snippetEnglishHash,
  snippetTranslationChangeSchema,
  snippetTranslationsSchema,
  SnippetSkeletonError,
  validateSnippetTranslation,
  type SnippetTranslationChange,
  type SnippetTranslation,
} from '../../../packages/core/src/localizedSnippets.js';
import {
  emptyTeamSnippets,
  snippetsPath,
  teamSnippetsSchema,
} from '../../../packages/core/src/customSnippets.js';
import { RefRace, type GitHub } from './github.js';
import { body, HttpError, json } from './http.js';
import { managedLanguages, permissions, requireAccess } from './permissions.js';
import type { Identity } from './types.js';

export async function localizedSnippetsRoute(
  request: Request,
  github: GitHub,
  user: Identity,
  rawLang: string,
) {
  const parsedLang = localizedSnippetLangSchema.safeParse(rawLang);
  if (!parsedLang.success) throw new HttpError(400, 'Invalid snippets language');
  const lang = parsedLang.data;
  if (github.env.DATA_BRANCH !== 'editor-data')
    throw new HttpError(503, 'Snippet destination is not configured');
  const path = `snippets/${lang}.json`;
  const write = request.method === 'PUT';
  const management =
    request.method === 'GET' && new URL(request.url).searchParams.get('view') === 'translations';
  let change: SnippetTranslationChange | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github.head();
    const access = requireAccess(await permissions(github, head), user, [
      'maintainer',
      'editor',
      'trial',
      'translator',
    ]);
    const canManage = access.role === 'maintainer' || managedLanguages(access).includes(lang);
    if ((write || management) && !canManage)
      throw new HttpError(
        403,
        'Only this language’s translation managers and maintainers may edit its snippets',
      );
    const [file, teamFile] = await Promise.all([
      github.file(path, head, write),
      management ? Promise.resolve(null) : github.file(snippetsPath, head, write),
    ]);
    const stored = snippetTranslationsSchema.safeParse(file?.value ?? {});
    const team = teamSnippetsSchema.safeParse(teamFile?.value ?? emptyTeamSnippets());
    if (!stored.success || !team.success) throw new HttpError(502, 'Invalid stored snippets');
    const english = [...localizableBuiltIns, ...team.data.snippets];
    const translations = stored.data;
    if (management) return json({ translations });
    if (!write) {
      const snippets = await Promise.all(
        english.map(async (source) => {
          const enHash = await snippetEnglishHash(source.template);
          const translation = translations[source.id];
          const outdated = !!translation && translation.enHash !== enHash;
          let valid = false;
          if (translation && !outdated) {
            try {
              validateSnippetTranslation(source.template, translation.template);
              valid = true;
            } catch (error) {
              if (!(error instanceof SnippetSkeletonError)) throw error;
            }
          }
          return {
            id: source.id,
            label: valid ? translation!.label : source.label,
            keywords: (valid ? translation!.keywords : source.keywords) ?? '',
            template: valid ? translation!.template : source.template,
            enHash,
            language: valid ? lang : ('en' as const),
            hint: valid ? null : ('EN' as const),
            outdated,
          };
        }),
      );
      return json({
        snippets,
        outdated: canManage ? snippets.filter((s) => s.outdated).map((s) => s.id) : [],
        canManage,
      } satisfies import('../../../packages/core/src/localizedSnippets.js').EffectiveSnippetsResponse);
    }
    change ??= await body(request, snippetTranslationChangeSchema, 32_000);
    const current: SnippetTranslation | null = Object.hasOwn(translations, change.id)
      ? translations[change.id]!
      : null;
    if (stableStringify(current) !== stableStringify(change.base))
      return json(
        { error: 'Snippet translation changed; reload and retry', id: change.id, head: current },
        409,
      );
    if (change.next) {
      const source = english.find((s) => s.id === change!.id);
      if (!source) throw new HttpError(400, 'Unknown English snippet');
      if (change.next.enHash !== (await snippetEnglishHash(source.template)))
        throw new HttpError(409, 'English snippet changed; reload before translating');
      try {
        validateSnippetTranslation(source.template, change.next.template);
      } catch (error) {
        if (error instanceof SnippetSkeletonError)
          throw new HttpError(400, error.message, { name: error.name });
        throw error;
      }
    }
    if (stableStringify(current) === stableStringify(change.next)) return json({ translations });
    if (change.next) translations[change.id] = change.next;
    else delete translations[change.id];
    try {
      const commit = await github.commit(
        head,
        { [path]: translations },
        `Update ${lang} snippet ${change.id} by ${user.login}`,
        user,
      );
      return json({ commit, translations });
    } catch (error) {
      if (!(error instanceof RefRace)) throw error;
    }
  }
  throw new HttpError(409, 'Data branch kept moving; reload snippet translations and retry');
}
