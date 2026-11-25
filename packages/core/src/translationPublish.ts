import type { Aliases } from './aliases.js';
import type { GlobalDefinition, GlobalRecord } from './globals/model.js';
import { publishableHash } from './publishableHash.js';
import type { LangText, Tooltip } from './schemas.js';
import { translationLanguageSchema, translationReviewDigest } from './translationPublishRequest.js';
import type { TranslationLanguage } from './translationPublishRequest.js';

type TooltipSource = Pick<Tooltip, 'hash'> & { text: Pick<Tooltip['text'], 'en'> };
type GlobalSource = Pick<GlobalRecord, 'id' | 'kind' | 'tombstone'> & {
  definitions: Pick<GlobalRecord['definitions'], 'en'>;
};
type PublishedSource<T> =
  { status: 'active'; entry: T } | { status: 'missing' | 'unverified' | 'inactive' };
export type TranslationEnglishGateInput =
  | {
      kind: 'tooltip';
      hash: number;
      saved: TooltipSource | undefined;
      live: PublishedSource<TooltipSource>;
      liveAliases: Aliases;
    }
  | {
      kind: 'global';
      id: string;
      saved: GlobalSource | undefined;
      live: PublishedSource<GlobalSource>;
    };

export const translationPublishReasons = {
  'missing-saved': 'Reload Review changes. The saved entry is missing.',
  'identity-mismatch': 'Reload Review changes. The saved and published entries do not match.',
  'reserved-tooltip': 'Publish shared library changes with an editor or maintainer.',
  'alias-root': 'Select the original tooltip to publish this translation.',
  inactive: 'An editor or maintainer must publish this entry as active first.',
  'global-removed':
    'This shared text is marked for removal. Ask an editor or maintainer to review it.',
  'missing-live': 'An editor or maintainer must publish this entry first.',
  'unverified-live':
    'The published source could not be verified. Ask an editor or maintainer to repair it.',
  'english-pending': 'The English change is still waiting to be published.',
  'missing-live-english': 'An editor or maintainer must publish English for this entry first.',
  'missing-live-input':
    'A number, variable, or import in this translation is missing from the published text.',
  'translation-check-limit': 'This text is too large to check here. Ask an editor to publish it.',
  'review-changed':
    'This translation or what it uses has changed. Review it again before publishing.',
} as const;
export type TranslationPublishReason = keyof typeof translationPublishReasons;
export type TranslationEnglishGate =
  | { status: 'ready' }
  | {
      status: 'waiting';
      reason: 'missing-live' | 'unverified-live' | 'english-pending' | 'missing-live-english';
    }
  | {
      status: 'refused';
      reason:
        | 'missing-saved'
        | 'identity-mismatch'
        | 'reserved-tooltip'
        | 'alias-root'
        | 'inactive'
        | 'global-removed';
    };

/**
 * Orders translation publication by English revision. Scoped publication separately checks
 * language authorization and uses LIVE English, including when a crafted save reuses a
 * stamp. It applies only the authorized language's saved entry and verified derived changes.
 */
export function translationEnglishGate(input: TranslationEnglishGateInput): TranslationEnglishGate {
  if (input.kind === 'tooltip') {
    if (input.hash >= 1 && input.hash <= 3)
      return { status: 'refused', reason: 'reserved-tooltip' };
    if (Object.hasOwn(input.liveAliases, input.hash))
      return { status: 'refused', reason: 'alias-root' };
  }
  if (!input.saved) return { status: 'refused', reason: 'missing-saved' };
  if (input.live.status === 'missing') return { status: 'waiting', reason: 'missing-live' };
  if (input.live.status === 'unverified') return { status: 'waiting', reason: 'unverified-live' };
  if (input.live.status !== 'active') return { status: 'refused', reason: 'inactive' };

  let saved: LangText | GlobalDefinition | undefined;
  let live: typeof saved;
  if (input.kind === 'tooltip') {
    if (input.saved.hash !== input.hash || input.live.entry.hash !== input.hash)
      return { status: 'refused', reason: 'identity-mismatch' };
    saved = input.saved.text.en;
    live = input.live.entry.text.en;
  } else {
    if (
      input.saved.id !== input.id ||
      input.live.entry.id !== input.id ||
      input.saved.kind !== input.live.entry.kind
    )
      return { status: 'refused', reason: 'identity-mismatch' };
    if (input.live.entry.tombstone) return { status: 'refused', reason: 'inactive' };
    if (input.saved.tombstone) return { status: 'refused', reason: 'global-removed' };
    saved = input.saved.definitions.en;
    live = input.live.entry.definitions.en;
  }
  // A clear waits whatever its revision says ("No translation impact" keeps the stamps).
  if (
    live &&
    'text' in live &&
    live.text.trim() &&
    !(saved && 'text' in saved && saved.text.trim())
  )
    return { status: 'waiting', reason: 'english-pending' };
  if (
    saved?.updatedAt !== live?.updatedAt ||
    saved?.updatedBy !== live?.updatedBy ||
    (saved && 'revision' in saved ? saved.revision : undefined) !==
      (live && 'revision' in live ? live.revision : undefined)
  )
    return { status: 'waiting', reason: 'english-pending' };
  if (!live || ('text' in live && !live.text.trim()))
    return { status: 'waiting', reason: 'missing-live-english' };
  return { status: 'ready' };
}

type Entry = LangText | GlobalDefinition;

export function translationExpectedDigest(entry: Entry | undefined): Promise<string> {
  return translationReviewDigest(entry ?? null);
}

/** Bind LIVE English and its number bindings independently of other language fallback bits. */
export function translationEnglishDigest(entry: Entry): Promise<string> {
  if (!('text' in entry) || !entry.numbers) return translationReviewDigest(entry);
  const { numbers, ...english } = entry;
  const retired = Object.fromEntries(
    Object.entries(numbers.retired).map(([id, value]) => [
      id,
      value && typeof value === 'object'
        ? { value: value.value, variables: value.variables }
        : value,
    ]),
  );
  return translationReviewDigest({ ...english, numbers: { ids: numbers.ids, retired } });
}

export function translationFallbackIds(
  english: LangText | undefined,
  lang: TranslationLanguage,
): number[] {
  return Object.entries(english?.numbers?.retired ?? {}).flatMap(([id, value]) =>
    value && typeof value === 'object' && value.fallback.includes(lang) ? [Number(id)] : [],
  );
}

export function translationBeforeDigest(
  entry: Entry | undefined,
  fallbackIds: readonly number[] = [],
): Promise<string> {
  return translationReviewDigest({
    entry: entry ?? null,
    fallbackIds: [...fallbackIds].sort((a, b) => a - b),
  });
}

export function translationAffectedDigest(hashes: readonly number[]): Promise<string> {
  return translationReviewDigest([...new Set(hashes)].sort((a, b) => a - b));
}

/**
 * Patch one lane in a verified active LIVE root. Fallback IDs come from server-verified LIVE
 * bindings. For each retired binding only membership of the selected language can change.
 */
export async function composeTooltipTranslation(
  live: Tooltip,
  lang: TranslationLanguage,
  entry: LangText | undefined,
  fallbackIds: readonly number[],
  liveAliases: Aliases,
): Promise<{ tooltip: Tooltip; marker: string }> {
  translationLanguageSchema.parse(lang);
  if ((live.hash >= 1 && live.hash <= 3) || Object.hasOwn(liveAliases, live.hash))
    throw new Error('Only an original published tooltip can be composed');
  const text = { ...live.text };
  if (entry) text[lang] = entry;
  else delete text[lang];

  const english = live.text.en;
  const numbers = english?.numbers;
  const wanted = new Set(fallbackIds);
  for (const id of wanted) {
    const retired = numbers?.retired[id];
    if (!retired || typeof retired !== 'object')
      throw new Error(`Number ${id} has no published fallback binding`);
  }
  if (english && numbers) {
    const retired = { ...numbers.retired };
    let changed = false;
    for (const [id, value] of Object.entries(numbers.retired)) {
      if (!value || typeof value !== 'object') continue;
      const enabled = wanted.has(Number(id));
      if (enabled === value.fallback.includes(lang)) continue;
      retired[id] = {
        ...value,
        fallback: enabled
          ? [...value.fallback, lang]
          : value.fallback.filter((code) => code !== lang),
      };
      changed = true;
    }
    if (changed) text.en = { ...english, numbers: { ...numbers, retired } };
  }
  const tooltip = { ...live, text };
  return { tooltip, marker: await publishableHash(tooltip, liveAliases) };
}

export function composeGlobalTranslation(
  live: GlobalRecord,
  lang: TranslationLanguage,
  entry: GlobalDefinition | undefined,
): GlobalRecord {
  translationLanguageSchema.parse(lang);
  const definitions = { ...live.definitions };
  if (entry) definitions[lang] = entry;
  else delete definitions[lang];
  return { ...live, definitions };
}

/** Both trees must be exact path-to-blob maps. Build allowed OIDs independently of the candidate. */
export function verifyTranslationPublishTree(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  allowed: ReadonlyMap<string, string | null>,
): { ok: true } | { ok: false; path: string } {
  for (const [path, oid] of allowed) {
    const actual = Object.hasOwn(after, path) ? after[path] : null;
    if (actual !== oid) return { ok: false, path };
  }
  for (const path of Object.keys(before)) {
    if (!allowed.has(path) && (!Object.hasOwn(after, path) || before[path] !== after[path]))
      return { ok: false, path };
  }
  for (const path of Object.keys(after)) {
    if (!allowed.has(path) && !Object.hasOwn(before, path)) return { ok: false, path };
  }
  return { ok: true };
}
