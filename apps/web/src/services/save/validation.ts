import {
  countConflicts,
  emptyEnglishMessage,
  hasTooltipText,
  languages,
  maskConflicts,
  resolveAlias,
  validateGlobalAdditions,
  validateTooltip,
  type Tooltip,
  type TooltipValidationIssue,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Change } from '../api';
import { saveDependencies } from './dependencies';

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

export function validateChanges(changes: Change[], data: EditorData): TooltipValidationIssue[] {
  const tooltips = { ...data.bundle.tooltips };
  for (const change of changes) {
    if (resolveAlias(change.hash, data.aliases) !== change.hash) {
      throw new Error(
        `Tooltip ${change.hash} is an alias. Recover its draft into the canonical tooltip first.`,
      );
    }
    tooltips[change.hash] = withoutMarkers(change.next);
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
  const dependencies = saveDependencies(changes, before, tooltips, data);
  const issues = changes.flatMap(({ base, next: unmasked }) => {
    const next = tooltips[unmasked.hash]!;
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
      ...validateGlobalAdditions({ base, next }, tooltips),
      // An error blocks if the tooltip's text there is edited, or if the text uses something this
      // same save changes (an imported document, a global it mentions): then the save may have
      // caused it. Any other error in unchanged text only warns, so a link-only change on a
      // tooltip with unwritten English is never refused.
      ...validateTooltip(next, (lang) => dependencies.globalsFor(next.hash, lang), base, {
        aliases: data.aliases,
        affectedBy: dependencies.affectedBy,
      })
        .map((issue) =>
          !base && issue.lang === 'en' && issue.message === emptyEnglishMessage
            ? { ...issue, message: noTooltipYet }
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
        ),
    ];
  });
  return [...issues, ...dependencies.outsideIssues()];
}
