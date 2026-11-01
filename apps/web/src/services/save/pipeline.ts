import { languageLabel } from '../../languageLabels';
import {
  languages,
  resolveAlias,
  stableStringify,
  validateTooltip,
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

export function validateChanges(changes: Change[], data: EditorData): TooltipValidationIssue[] {
  const tooltips = { ...data.bundle.tooltips };
  for (const change of changes) {
    if (resolveAlias(change.hash, data.aliases) !== change.hash) {
      throw new Error(
        `Tooltip ${change.hash} is an alias. Recover its draft into the canonical tooltip first.`,
      );
    }
    tooltips[change.hash] = change.next;
  }
  const imports = new Map(
    languages.map((lang) => [lang, tooltipImports(tooltips, {}, lang, data.aliases)]),
  );
  return changes.flatMap(({ next }) =>
    validateTooltip(next, (lang) => {
      const catalog = imports.get(lang)!;
      const item = data.items[next.hash];
      return {
        variables: catalog[2] ?? '',
        titles: catalog[3] ?? '',
        imports: catalog,
        type: data.categories.find((category) => category.id === item?.categoryId)?.legacyType,
      };
    }),
  );
}

export async function prepareChanges(
  changes: Change[],
  user: Me,
  data: EditorData,
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
      }),
    })),
  );
}
