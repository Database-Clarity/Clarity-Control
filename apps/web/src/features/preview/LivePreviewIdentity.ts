import { createContext } from 'react';
import type { EditorData } from '../../stores/data';
import { archiveCategoryLabel, archivedItemFor } from '../archive/archive';
import { exoticPiece, tooltipFor } from '../navigation/catalog';

/** Route identity paints independently of the deferred editor and preview document. */
export interface PreviewIdentity {
  name: string;
  piece?: string;
  icon?: string;
  categoryLabel?: string;
  archiveIcon?: boolean;
}

export const LivePreviewIdentity = createContext<PreviewIdentity | undefined>(undefined);

export function previewIdentityFor(
  hash: number,
  data: EditorData | null,
  readOnly = false,
): PreviewIdentity {
  const item = data && archivedItemFor(hash, data);
  const category = data?.categories.find((entry) => entry.id === item?.categoryId);
  const archived =
    readOnly || Boolean(data && hash > 3 && !data.items[hash] && !tooltipFor(hash, data).custom);
  return {
    name: item?.name ?? `Tooltip ${hash}`,
    piece: (item && exoticPiece(item)) || undefined,
    icon: item?.icon || undefined,
    categoryLabel: [
      archived && item && data
        ? archiveCategoryLabel(item.categoryId, data)
        : (category?.label ?? item?.categoryId),
      hash,
    ]
      .filter(Boolean)
      .join(' · '),
    archiveIcon: archived,
  };
}
