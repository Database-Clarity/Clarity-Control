import {
  hasTooltipText,
  isMarkupOnly,
  languages,
  isTextlessDescription,
  permissionsSchema,
  stableStringify,
  type Permissions,
  type Tooltip,
} from '@clarity/core';
import { HttpError } from './http.js';
import type { GitHub } from './github.js';
import type { Identity } from './types.js';

export type Access = Permissions['users'][string];

export async function permissions(github: GitHub, head: string): Promise<Permissions> {
  return permissionsSchema.parse(
    (await github.requiredFile('config/permissions.json', head)).value,
  );
}

export function requireAccess(
  config: Permissions,
  user: Identity,
  roles: Access['role'][],
): Access {
  const access = config.users[String(user.id)];
  if (!access || !roles.includes(access.role)) throw new HttpError(403, 'Permission denied');
  return access;
}

/** Export projects the user is a partner of (spec section 4); empty for everyone else. */
export function partnerProjects(config: Permissions, user: Identity): readonly string[] {
  return config.partners?.[String(user.id)]?.projects ?? [];
}

/**
 * The role `/me` reports. `users` decides; an account listed only in `partners` is a `partner`.
 * `partner` is never accepted by `requireAccess`, so every route that checks `users` denies it
 * by default; only the export routes read `partners`.
 */
export function roleOf(config: Permissions, user: Identity): Access['role'] | 'partner' | null {
  return (
    config.users[String(user.id)]?.role ?? (partnerProjects(config, user).length ? 'partner' : null)
  );
}

export function checkEdit(access: Access, base: Tooltip | null, next: Tooltip): void {
  if (isTextlessDescription(next) && (base === null || hasTooltipText(base))) {
    if (!['maintainer', 'editor'].includes(access.role))
      throw new HttpError(403, 'Only editors and maintainers can create link-only tooltips');
    if (base === null && !next.compendium)
      throw new HttpError(422, 'A text-less tooltip requires a Compendium link');
  }
  if (access.role === 'translator' && base === null)
    throw new HttpError(403, 'Translators may not create tooltips');
  // A link-only record is not an English source for translations. Check both the
  // submitted base and the real head (save calls checkEdit again after merging).
  if (
    next.hash > 3 &&
    base &&
    !hasTooltipText(base) &&
    hasTooltipText(next) &&
    !next.text.en?.text.trim()
  )
    throw new HttpError(422, 'Write English text before adding translations to this tooltip');
  if (
    JSON.stringify(base?.archive) !== JSON.stringify(next.archive) &&
    access.role !== 'maintainer' &&
    !(access.role === 'editor' && base?.archive && !next.archive)
  )
    throw new HttpError(403, 'Archive changes require maintainer role');
  const categoryChanged = base?.custom?.categoryId !== next.custom?.categoryId;
  const attachmentCategoryChange = [base?.custom?.categoryId, next.custom?.categoryId].some(
    (category) => category === 'weapon-attachment' || category === 'attachment-effect',
  );
  if (
    categoryChanged &&
    attachmentCategoryChange &&
    !['editor', 'maintainer'].includes(access.role)
  )
    throw new HttpError(403, 'Attachment category changes require editor role or higher');
  if (access.role !== 'translator') return;
  const withoutAllowed = (value: Tooltip) => ({
    ...value,
    text: Object.fromEntries(
      Object.entries(value.text).filter(
        ([lang]) => !access.languages?.includes(lang as keyof Tooltip['text']),
      ),
    ),
  });
  const original = base!;
  if (stableStringify(withoutAllowed(original)) !== stableStringify(withoutAllowed(next))) {
    throw new HttpError(403, 'Translators may change only text in their assigned languages');
  }
}

/**
 * The English revision rule (TR3 "No translation impact"). `head` is the stored tooltip the save
 * replaces, `next` what it commits. When the English text changes beyond markup:
 * - a kept English revision (same `updatedAt`) keeps every translation's outdated and 90-day
 *   fallback state, so it needs the save's `noTranslationImpact` flag and an editor or maintainer
 *   (never trials or translators), and must keep `updatedBy` too: returns 'kept' (the trailer);
 * - otherwise the new revision must be newer than the stored one: a backdated revision would
 *   keep translations current without the flag.
 * Saves without such an English change (translation-only, fields, markup-only) return 'none'
 * and ignore the flag. Their English must keep the stored revision exactly (the editor's
 * enricher does): otherwise a later save could move the stamps back and arrive at a kept
 * revision unflagged, or move them forward and flip translations to the English fallback.
 * English (re-)added to a stored tooltip that kept translations must be newer than the English
 * those translations were based on.
 */
export function checkEnglishRevision(
  access: Access,
  head: Tooltip | null,
  next: Tooltip,
  noTranslationImpact: boolean,
  now = Date.now(),
): 'none' | 'new' | 'kept' {
  const before = head?.text.en;
  const after = next.text.en;
  if (!after) return 'none';
  // A far-future revision would flip every translation to the English fallback and freeze the
  // gap (later saves clamp to it + 1 ms): refuse one more than 5 minutes ahead of Worker time,
  // except exactly the stored revision + 1 ms (the editor's clamp behind such a stamp).
  const future = () => {
    const at = Date.parse(after.updatedAt);
    if (at > now + 5 * 60_000 && !(before && at === Date.parse(before.updatedAt) + 1))
      throw new HttpError(
        422,
        `Tooltip ${next.hash}: the English revision is in the future; check your device clock`,
      );
  };
  if (!before) {
    future();
    const sources = languages
      .map((lang) => (lang === 'en' ? undefined : head?.text[lang]?.sourceUpdatedAt))
      .filter((source): source is string => source !== undefined)
      .map((source) => Date.parse(source));
    if (sources.length && !(Date.parse(after.updatedAt) > Math.max(...sources)))
      throw new HttpError(
        422,
        `Tooltip ${next.hash}: the new English revision must be newer than its translations' source`,
      );
    return 'none';
  }
  if (after.text === before.text || isMarkupOnly(before.text, after.text)) {
    if (after.updatedAt !== before.updatedAt || after.updatedBy !== before.updatedBy)
      throw new HttpError(
        422,
        `Tooltip ${next.hash}: unchanged English must keep its stored revision`,
      );
    return 'none';
  }
  if (after.updatedAt === before.updatedAt) {
    if (!noTranslationImpact)
      throw new HttpError(
        422,
        `Tooltip ${next.hash}: English text changed without a new English revision`,
      );
    if (access.role !== 'maintainer' && access.role !== 'editor')
      throw new HttpError(
        403,
        'Only editors and maintainers can mark a save as having no translation impact',
      );
    if (after.updatedBy !== before.updatedBy)
      throw new HttpError(
        422,
        `Tooltip ${next.hash}: a change with no translation impact keeps the English revision author`,
      );
    return 'kept';
  }
  if (!(Date.parse(after.updatedAt) > Date.parse(before.updatedAt)))
    throw new HttpError(
      422,
      `Tooltip ${next.hash}: the new English revision must be newer than the stored one`,
    );
  future();
  return 'new';
}

/**
 * Translation stamps, by the same rule (TR3 triage O1): a translation whose text is unchanged or
 * changed only in markup keeps the stored `updatedAt`, `updatedBy`, and `sourceUpdatedAt`
 * exactly; a changed one next to English must name a source revision no later than the English
 * it is saved with. Otherwise a crafted save could mark a translation current through an English rewrite
 * (the tick's effect, unflagged) or make it permanently immune to outdated and fallback state.
 * The editor's enricher always satisfies both (it reuses the stored entry, and stamps a changed
 * translation with the English revision).
 */
export function checkTranslationStamps(head: Tooltip | null, next: Tooltip): void {
  const english = next.text.en;
  for (const lang of languages) {
    if (lang === 'en') continue;
    const before = head?.text[lang];
    const after = next.text[lang];
    if (!after) continue;
    if (before && (after.text === before.text || isMarkupOnly(before.text, after.text))) {
      if (
        after.updatedAt !== before.updatedAt ||
        after.updatedBy !== before.updatedBy ||
        after.sourceUpdatedAt !== before.sourceUpdatedAt
      )
        throw new HttpError(
          422,
          `Tooltip ${next.hash}: unchanged ${lang} text must keep its stored revision`,
        );
      continue;
    }
    // A missing source counts as permanently current in core (never outdated, never English
    // fallback), so a changed translation next to English must carry one (TR3 sec S1).
    if (english && after.sourceUpdatedAt === undefined)
      throw new HttpError(
        422,
        `Tooltip ${next.hash}: the changed ${lang} text needs the English revision it translates`,
      );
    if (english && !(Date.parse(after.sourceUpdatedAt!) <= Date.parse(english.updatedAt)))
      throw new HttpError(
        422,
        `Tooltip ${next.hash}: the ${lang} source revision is newer than the English revision`,
      );
  }
}

/**
 * The Worker twin of the editor's stampEnglish, for English composed on the Worker (resolving a
 * batch activation conflict): the same or markup-only text keeps current's English revision;
 * other text keeps its own revision when that is newer than current's, else gets `at` (or
 * current's plus 1 ms) with `login` as author. Translations are untouched.
 */
export function alignEnglishRevision(
  current: Tooltip | null,
  next: Tooltip,
  login: string,
  at: string,
): Tooltip {
  const english = next.text.en;
  const previous = current?.text.en;
  if (!english || !previous) return next;
  let en = english;
  if (english.text === previous.text || isMarkupOnly(previous.text, english.text))
    en = { ...previous, text: english.text };
  else if (!(Date.parse(english.updatedAt) > Date.parse(previous.updatedAt))) {
    const kept = Date.parse(previous.updatedAt);
    en = {
      ...english,
      updatedAt: kept >= Date.parse(at) ? new Date(kept + 1).toISOString() : at,
      updatedBy: login,
    };
  }
  return en === english ? next : { ...next, text: { ...next.text, en } };
}
