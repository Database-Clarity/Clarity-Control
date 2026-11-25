import {
  clearedEnglishMessage,
  countConflicts,
  emptyEnglishMessage,
  hasTooltipText,
  languages,
  maskConflicts,
  resolveAlias,
  usesEnglishFallback,
  validateGlobalAdditions,
  validateTextWithReads,
  validateTooltip,
  type Lang,
  type Tooltip,
  type TooltipValidationIssue,
} from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import type { EditorData } from '../../stores/data';
import type { Change } from '../api';
import { saveDependencies } from './dependencies';
import type { LiveFallback } from './fallback';

/** The tooltip with conflict blocks reduced to "mine", so validation sees real text only. */
function withoutMarkers(tooltip: Tooltip): Tooltip {
  if (!languages.some((lang) => countConflicts(tooltip.text[lang]?.text ?? '') > 0)) return tooltip;
  const text: Tooltip['text'] = {};
  for (const lang of languages) {
    const entry = tooltip.text[lang];
    if (entry) text[lang] = { ...entry, text: maskConflicts(entry.text) };
  }
  return { ...tooltip, text };
}

/** One error per language that still carries conflict markers: saving them would publish them. */
export function conflictMarkerIssues(changes: Change[]): TooltipValidationIssue[] {
  return changes.flatMap(({ next }) =>
    languages.flatMap((lang) => {
      const found = countConflicts(next.text[lang]?.text ?? '');
      return found > 0
        ? [
            {
              severity: 'error' as const,
              message: `${found === 1 ? '1 unresolved conflict' : `${found} unresolved conflicts`} (<<<<<<< markers). Resolve ${found === 1 ? 'it' : 'them'} in the editor before saving.`,
              from: 0,
              to: 0,
              hash: next.hash,
              lang,
            },
          ]
        : [];
    }),
  );
}

export const noTooltipYet =
  'This item has no tooltip yet. Add a Compendium link or write English text before saving.';

/**
 * The live form of a tooltip (EXPORT-FALLBACK-VALIDATION): each language in `fallback` holds the
 * English text, which live output exports for it. Validation checks a change's live forms: the
 * draft's after this save (fallback.liveFallback, on the save's own stamps) against the base's
 * (its real stamps), so text whose live form stays the same only blocks when it reads something
 * this save changes, by the usual rule.
 */
export function liveForm(tooltip: Tooltip, fallback: readonly Lang[] | undefined): Tooltip {
  const english = tooltip.text.en;
  if (!fallback?.length || !english) return tooltip;
  const text = { ...tooltip.text };
  for (const lang of fallback) {
    const entry = text[lang];
    if (entry) text[lang] = { ...entry, text: english.text };
  }
  return { ...tooltip, text };
}
const liveBase = (base: Tooltip) =>
  liveForm(
    base,
    languages.filter((lang) => usesEnglishFallback(base, lang)),
  );

export const fallbackNote = (lang: Lang) =>
  `After this save, live ${languageLabel(lang)} output uses the English text: the translation is more than 90 days of English revisions behind.`;

export function validateChanges(
  changes: Change[],
  data: EditorData,
  fallback: LiveFallback = {},
  /** Whether this save may clear the English text of a published tooltip. */
  clearing = false,
): TooltipValidationIssue[] {
  const tooltips = { ...data.bundle.tooltips };
  for (const change of changes) {
    if (resolveAlias(change.hash, data.aliases) !== change.hash) {
      throw new Error(
        `Tooltip ${change.hash} is an alias. Recover its draft into the canonical tooltip first.`,
      );
    }
    tooltips[change.hash] = liveForm(withoutMarkers(change.next), fallback[change.hash]);
  }
  // Restore draft bases for the before snapshot, including recovered drafts and new tooltips.
  const before = { ...data.bundle.tooltips };
  for (const change of changes) {
    if (change.base) {
      const base = withoutMarkers(change.base);
      const saved = before[change.hash];
      if (!saved || languages.some((lang) => saved.text[lang]?.text !== base.text[lang]?.text))
        before[change.hash] = base;
    } else delete before[change.hash];
  }
  const dependencies = saveDependencies(changes, before, tooltips, data, fallback);
  const issues = changes.flatMap(({ base, next: unmasked }) => {
    const next = tooltips[unmasked.hash]!;
    const live = base && liveBase(withoutMarkers(base));
    const raw = withoutMarkers(unmasked);
    return [
      ...(next.hash > 3 &&
      base &&
      !hasTooltipText(base) &&
      hasTooltipText(next) &&
      !next.text.en?.text.trim()
        ? [
            {
              hash: next.hash,
              lang: 'en' as const,
              severity: 'error' as const,
              message: 'Write English text before adding translations to this tooltip',
              from: 0,
              to: 0,
            },
          ]
        : []),
      ...conflictMarkerIssues([{ hash: unmasked.hash, base, next: unmasked }]),
      ...validateGlobalAdditions({ base: live, next }, tooltips),
      // An error blocks if the tooltip's text there is edited, or if the text uses something this
      // same save changes (an imported document, a global it mentions): then the save may have
      // caused it. Any other error in unchanged text only warns, so a link-only change on a
      // tooltip with unwritten English is never refused.
      ...validateTooltip(next, (lang) => dependencies.globalsFor(next.hash, lang), live, {
        aliases: data.aliases,
        affectedBy: dependencies.affectedBy,
      })
        .map((issue) =>
          !base && issue.lang === 'en' && issue.message === emptyEnglishMessage
            ? { ...issue, message: noTooltipYet }
            : clearing &&
                issue.lang === 'en' &&
                issue.message === emptyEnglishMessage &&
                data.bundle.pushed[next.hash] !== undefined &&
                base?.text.en?.text.trim()
              ? { ...issue, severity: 'warning' as const, message: clearedEnglishMessage }
              : issue,
        )
        .filter(
          (issue) =>
            !(
              next.compendium &&
              !hasTooltipText(next) &&
              (!base || !hasTooltipText(base)) &&
              issue.message === noTooltipYet
            ),
        )
        .map((issue) =>
          fallback[next.hash]?.includes(issue.lang)
            ? { ...issue, message: `${issue.message} ${fallbackNote(issue.lang)}` }
            : issue,
        ),
      // A translation edited in a language that still falls back (a markup-only edit keeps its
      // stamps) is not live, but is checked as edited text, as before.
      ...(fallback[next.hash] ?? [])
        .filter((lang) => base && raw.text[lang]?.text !== withoutMarkers(base).text[lang]?.text)
        .flatMap((lang) =>
          validateTextWithReads(
            raw.text[lang]?.text ?? '',
            lang,
            dependencies.globalsFor(next.hash, lang),
            false,
            next.hash,
            data.aliases,
          ).issues.map((issue) => ({ ...issue, hash: next.hash, lang })),
        ),
    ];
  });
  return [...issues, ...dependencies.outsideIssues()];
}
