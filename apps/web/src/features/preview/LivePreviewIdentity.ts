import { createContext } from 'react';
import type { EditorData } from '../../stores/data';
import { archiveCategoryLabel, archivedItemFor } from '../archive/archive';
import { classifiedCategory, previewPiece, tooltipFor } from '../navigation/catalog';
import { previewPieceIcon } from '../navigation/groupIcons';

/** Route identity paints independently of the deferred editor and preview document. */
export interface PreviewIdentity {
  name: string;
  piece?: string;
  /** The piece's icon beside the piece row ('' = a piece missing from the icon file). */
  pieceIcon?: string;
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
  const category = data ? classifiedCategory(item, data) : undefined;
  const archived =
    readOnly || Boolean(data && hash > 3 && !data.items[hash] && !tooltipFor(hash, data).custom);
  return {
    name: item?.name ?? `Tooltip ${hash}`,
    piece: item ? previewPiece(item) : undefined,
    pieceIcon: item ? previewPieceIcon(item) : undefined,
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
