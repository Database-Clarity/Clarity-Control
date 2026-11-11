import { languageLabel } from '../../languageLabels';
import { type CompendiumData, hasTooltipText, languages, stableStringify } from '@clarity/core';
import { canEditLanguage, canEditTooltipFields } from '../../features/auth/permissions';
import type { EditorData } from '../../stores/data';
import type { Change, Me } from '../api';
import { requestSaveValidation } from './validationWorker';
export { conflictMarkerIssues, noTooltipYet, validateChanges } from './validation';
import { enrichTooltip } from './enrichers';

export function permissionError(changes: Change[], user: Me | null): string | null {
  if (!user?.role) return 'Sign in with an editing role before saving.';
  if (
    user.role === 'trial' &&
    changes.some(({ base, next }) => !hasTooltipText(next) && (!base || hasTooltipText(base)))
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

export async function prepareChanges(
  changes: Change[],
  user: Me,
  data: EditorData,
  compendium?: CompendiumData,
): Promise<Change[]> {
  const denied = permissionError(changes, user);
  if (denied) throw new Error(denied);
  const issues = await requestSaveValidation(changes, data);
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
      }),
    })),
  );
}
