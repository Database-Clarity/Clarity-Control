import { languageLabel } from '../../languageLabels';
import {
  type CompendiumData,
  hasTooltipText,
  isTextlessDescription,
  languages,
  stableStringify,
} from '@clarity/core';
import { canEditLanguage, canEditTooltipFields } from '../../features/auth/permissions';
import type { EditorData } from '../../stores/data';
import type { Change, Me } from '../api';
import { requestSaveValidation } from './validationWorker';
export { conflictMarkerIssues, noTooltipYet, validateChanges } from './validation';
import { enrichTooltip } from './enrichers';
import { liveFallback } from './fallback';

export function permissionError(changes: Change[], user: Me | null): string | null {
  if (!user?.role) return 'Sign in with an editing role before saving.';
  if (
    user.role === 'trial' &&
    changes.some(({ base, next }) => isTextlessDescription(next) && (!base || hasTooltipText(base)))
  )
    return 'Only editors and maintainers can create link-only tooltips.';
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

/**
 * Validates, then stamps, the save. One revision time serves both: validation checks the live
 * English fallback (fallback.ts) predicted with exactly the stamps the enrichers then write.
 * `noTranslationImpact` ("No translation impact", editors and maintainers) keeps the English
 * revision of English wording changes; the Worker enforces the role and records it.
 */
export async function prepareChanges(
  changes: Change[],
  user: Me,
  data: EditorData,
  compendium?: CompendiumData,
  options: { noTranslationImpact?: boolean } = {},
): Promise<Change[]> {
  const denied = permissionError(changes, user);
  if (denied) throw new Error(denied);
  const noTranslationImpact = options.noTranslationImpact === true;
  if (noTranslationImpact && user.role !== 'maintainer' && user.role !== 'editor')
    throw new Error(
      'Only editors and maintainers can mark a save as having no translation impact.',
    );
  const now = new Date().toISOString();
  const issues = await requestSaveValidation(
    changes,
    data,
    liveFallback(changes, now, noTranslationImpact),
  );
  if (issues.some((issue) => issue.severity === 'error')) {
    const dependents = [
      ...new Set(
        issues
          .filter(
            (issue) =>
              issue.severity === 'error' && !changes.some((change) => change.hash === issue.hash),
          )
          .map((issue) => issue.hash),
      ),
    ];
    throw new Error(
      `Validation errors must be fixed before saving.${dependents.length ? ` This save would break dependent tooltip(s): ${dependents.join(', ')}.` : ''}`,
    );
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
        now,
        ...(noTranslationImpact ? { noTranslationImpact } : {}),
      }),
    })),
  );
}
