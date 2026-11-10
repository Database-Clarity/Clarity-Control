import { languageLabel } from '../../languageLabels';
import {
  type CompendiumData,
  batchReach,
  countConflicts,
  emptyEnglishMessage,
  languages,
  type Lang,
  maskConflicts,
  resolveAlias,
  stableStringify,
  validateGlobalAdditions,
  validateTooltip,
  type Tooltip,
  type TooltipValidationIssue,
} from '@clarity/core';
import { canEditLanguage, canEditTooltipFields } from '../../features/auth/permissions';
import type { EditorData } from '../../stores/data';
import type { Change, Me } from '../api';
import { tooltipImports } from '../tooltipImports';
import { enrichTooltip } from './enrichers';

export function permissionError(changes: Change[], user: Me | null): string | null {
  if (!user?.role) return 'Sign in with an editing role before saving.';
  if (canEditTooltipFields(user)) return null;
  for (const change of changes) {
    if (!change.base) return 'Translators cannot create tooltips.';
    const { text: beforeText, ...beforeFields } = change.base;
    const { text: nextText, ...nextFields } = change.next;
    if (stableStringify(beforeFields) !== stableStringify(nextFields)) {
      return `Tooltip ${change.hash}: translators can change only their assigned languages. Other fields changed.`;
    }
    for (const lang of languages) {
      if (
        !canEditLanguage(user, lang) &&
        JSON.stringify(beforeText[lang]) !== JSON.stringify(nextText[lang])
      ) {
        return `Tooltip ${change.hash}: you cannot edit ${languageLabel(lang)}. Your draft was preserved.`;
      }
    }
  }
  return null;
}

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
  'This item has no tooltip yet. A Compendium link or other change can be saved once English text is written.';

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
  // The same catalogue before this save: every change replaced by its base (a new tooltip
  // removed). batchReach follows imports through both, so a removed or new target counts.
  const before = { ...data.bundle.tooltips };
  for (const change of changes) {
    if (change.base) before[change.hash] = withoutMarkers(change.base);
    else delete before[change.hash];
  }
  const importsOf = (catalogue: Record<string, Tooltip>) =>
    new Map(languages.map((lang) => [lang, tooltipImports(catalogue, {}, lang, data.aliases)]));
  const imports = importsOf(tooltips);
  const importsBefore = importsOf(before);
  const globalsIn = (byLanguage: typeof imports, hash: number) => (lang: Lang) => {
    const catalog = byLanguage.get(lang)!;
    const item = data.items[hash];
    return {
      variables: catalog[2] ?? '',
      titles: catalog[3] ?? '',
      imports: catalog,
      type: data.categories.find((category) => category.id === item?.categoryId)?.legacyType,
    };
  };
  const reach = batchReach(
    changes,
    {
      before: (lang, hash) => importsBefore.get(lang)![String(hash)],
      after: (lang, hash) => imports.get(lang)![String(hash)],
    },
    data.aliases,
    (hash) => data.items[hash]?.name ?? `Tooltip ${hash}`,
  );
  return changes.flatMap(({ base, next: unmasked }) => {
    const next = tooltips[unmasked.hash]!;
    return [
      ...conflictMarkerIssues([{ hash: unmasked.hash, base, next: unmasked }]),
      ...validateGlobalAdditions({ base, next }, tooltips),
      // An error blocks if the tooltip's text there is edited, or if the text uses something this
      // same save changes (an imported document, a global it mentions): then the save may have
      // caused it. Any other error in unchanged text only warns, so a link-only change on a
      // tooltip with unwritten English is never refused.
      ...validateTooltip(next, globalsIn(imports, next.hash), base, reach).map((issue) =>
        // Saving never creates a tooltip without English text. Say so where the user acts: a
        // Compendium link on an item with no saved tooltip is refused for this reason alone.
        !base && issue.lang === 'en' && issue.message === emptyEnglishMessage
          ? { ...issue, message: noTooltipYet }
          : issue,
      ),
    ];
  });
}

export async function prepareChanges(
  changes: Change[],
  user: Me,
  data: EditorData,
  compendium?: CompendiumData,
): Promise<Change[]> {
  const denied = permissionError(changes, user);
  if (denied) throw new Error(denied);
  const issues = validateChanges(changes, data);
  if (issues.some((issue) => issue.severity === 'error')) {
    throw new Error('Validation errors must be fixed before saving.');
  }
  return Promise.all(
    changes.map(async (change) => ({
      ...change,
      next: await enrichTooltip({
        before: change.base ?? undefined,
        next: change.next,
        user,
        item: data.items[change.hash],
        ...(compendium ? { compendium } : {}),
      }),
    })),
  );
}
