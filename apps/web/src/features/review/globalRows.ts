import type { Lang } from '@clarity/core';
import type { GlobalKind } from '../globals/model';
import type { PendingGlobal } from './globalsPending';
import type { PendingTooltip } from './model';
import { publishedFor, type Published } from './published';

export interface GlobalPart {
  kind: GlobalKind;
  name: string;
  published: Published;
  source: {
    before: Partial<Record<Lang, string>>;
    after: Partial<Record<Lang, string>>;
  };
  change?: 'removed' | 'renamed';
  pending: PendingGlobal;
}

/** A row's identity is its tooltip hash or stable global ID. */
export type RowKey = number | string;
export const rowKey = ({ tooltip, part }: PendingTooltip): RowKey => part?.pending.id ?? tooltip.hash;

export const routedRow = <T extends PendingTooltip>(rows: readonly T[], routed: string): T | undefined =>
  rows.find((row) => String(rowKey(row)) === routed);

export const publishedOf = (entry: PendingTooltip, byHash: Parameters<typeof publishedFor>[0]) =>
  entry.part?.published ?? publishedFor(byHash, entry.tooltip.hash, entry.pushed);

export const editorPath = ({ tooltip, part }: PendingTooltip) =>
  part ? (part.change === 'removed' ? '/globals' : `/globals/${part.pending.id}`) : `/t/${tooltip.hash}`;

export const editorLabel = ({ part }: PendingTooltip) =>
  part?.change === 'removed' ? 'Open globals' : 'Open in editor';
