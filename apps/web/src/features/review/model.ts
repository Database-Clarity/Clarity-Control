import { publishableHash, resolveAlias, type Tooltip } from '@clarity/core';
import type { EditorData } from '../../stores/data';
export { canPushLive as canPush } from '../auth/permissions';

export interface PendingTooltip {
  tooltip: Tooltip;
  name: string;
  category: string;
  categoryId: string;
  categoryOrder: number;
}

export async function pendingTooltips(
  data: EditorData,
  pushed = data.bundle.pushed,
): Promise<PendingTooltip[]> {
  const entries = await Promise.all(
    Object.values(data.bundle.tooltips).map(async (tooltip) => {
      if (resolveAlias(tooltip.hash, data.aliases) !== tooltip.hash) return null;
      if ((await publishableHash(tooltip, data.aliases)) === pushed[tooltip.hash]) return null;
      const item = data.items[tooltip.hash];
      const categoryId = item?.categoryId ?? tooltip.custom?.categoryId ?? 'other';
      const category = data.categories.find((entry) => entry.id === categoryId);
      return {
        tooltip,
        name: item?.name ?? tooltip.custom?.name ?? `Tooltip ${tooltip.hash}`,
        category: category?.label ?? categoryId,
        categoryId,
        categoryOrder: category?.order ?? 9999,
      };
    }),
  );
  return entries
    .filter((entry): entry is PendingTooltip => entry !== null)
    .sort(
      (a, b) =>
        a.categoryOrder - b.categoryOrder ||
        a.category.localeCompare(b.category) ||
        a.name.localeCompare(b.name) ||
        a.tooltip.hash - b.tooltip.hash,
    );
}

export function toggleSelection(selected: ReadonlySet<number>, hash: number): Set<number> {
  const next = new Set(selected);
  if (!next.delete(hash)) next.add(hash);
  return next;
}

export function selectedPending(
  selected: ReadonlySet<number>,
  pending: PendingTooltip[],
): number[] {
  return pending
    .filter(({ tooltip }) => selected.has(tooltip.hash))
    .map(({ tooltip }) => tooltip.hash);
}

export function stepIndex(index: number, delta: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index + delta));
}
