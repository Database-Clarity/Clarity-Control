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

/** A row's identity is its tooltip hash or stable global ID, and a translator's row its language. */
export type RowKey = number | string;
export const rowKey = ({ tooltip, part, lane }: PendingTooltip): RowKey =>
  lane?.key ?? part?.pending.id ?? tooltip.hash;

/** Rows behind the list's quiet lines: never counted, listed, or included in bulk. */
export const isFolded = ({
  markerOnly,
  translationOnly,
}: Pick<PendingTooltip, 'markerOnly' | 'translationOnly'>) => markerOnly || !!translationOnly;

export const routedRow = <T extends PendingTooltip>(rows: readonly T[], routed: string): T | undefined =>
  rows.find((row) => String(rowKey(row)) === routed);

export const publishedOf = (entry: PendingTooltip, byHash: Parameters<typeof publishedFor>[0]) =>
  entry.lane
    ? (entry.lane.published ?? publishedFor(byHash, entry.lane.hash!, entry.lane.marker))
    : (entry.part?.published ?? publishedFor(byHash, entry.tooltip.hash, entry.pushed));

/** A translator's row opens in translate mode, on its own language. */
export const editorPath = ({ tooltip, part, lane }: PendingTooltip) =>
  lane
    ? lane.editorPath
    : part
      ? part.change === 'removed'
        ? '/globals'
        : `/globals/${part.pending.id}`
      : `/t/${tooltip.hash}`;

export const editorLabel = ({ part }: PendingTooltip) =>
  part?.change === 'removed' ? 'Open globals' : 'Open in editor';
