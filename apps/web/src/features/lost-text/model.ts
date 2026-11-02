import { z } from 'zod';
import { langSchema, type Tooltip } from '@clarity/core';
import type { User } from '../../services/api';
import { revertDraft } from '../history/revert';
import { sourceFingerprint } from '../compendium/reviewProgress';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const artifactSchema = z.object({
  version: z.literal(1),
  sourceCommit: sha,
  intermediateCommit: sha,
  manifestCommit: sha,
  records: z.array(
    z.object({
      hash: z.number().int().nonnegative(),
      lang: langSchema,
      name: z.string(),
      text: z.string().min(1),
      lastNonemptyCommit: sha,
      path: z.string(),
      clearingCommit: sha,
      clearingAuthor: z.string(),
      clearingDate: z.string(),
      classification: z.enum(['human', 'unclear', 'manifest-copy', 'placeholder']),
      reason: z.string(),
    }),
  ),
});
export type LostText = z.infer<typeof artifactSchema>['records'][number];
export const recordKey = (record: LostText) => `${record.hash}:${record.lang}`;
export const fingerprint = (record: LostText) =>
  sourceFingerprint([record.clearingCommit, record.lastNonemptyCommit, record.text]);
export const canRecover = (user: User | null | undefined) =>
  user?.role === 'editor' || user?.role === 'maintainer';
export function recoveryDraft(current: Tooltip, record: LostText, user: User): Tooltip {
  if (!canRecover(user)) throw new Error('Only editors and maintainers can recover text.');
  if (current.hash !== record.hash) throw new Error('Cannot recover a different tooltip.');
  if (current.text[record.lang]?.text.trim())
    throw new Error('This language now has text. Review it in the editor first.');
  const version = structuredClone(current);
  version.text[record.lang] = {
    text: record.text,
    updatedBy: user.login,
    updatedAt: new Date().toISOString(),
    ...(record.lang !== 'en' && current.text.en
      ? { sourceUpdatedAt: current.text.en.updatedAt }
      : {}),
  };
  return revertDraft(current, version, user);
}
export function visibleRecords(
  records: LostText[],
  tooltips: Record<string, Tooltip>,
  decisions: Record<string, string>,
  showCopies: boolean,
  classFilter = '',
  showDismissed = false,
) {
  return records.filter(
    (r) =>
      tooltips[r.hash] &&
      !tooltips[r.hash].text[r.lang]?.text.trim() &&
      (showCopies || r.classification === 'human' || r.classification === 'unclear') &&
      (!classFilter || r.classification === classFilter) &&
      (showDismissed || decisions[recordKey(r)] !== fingerprint(r)),
  );
}
