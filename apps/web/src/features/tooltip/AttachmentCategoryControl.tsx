import type { Tooltip } from '@clarity/core';
import type { Item } from '../../services/generator';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import { apiUrl } from '../../services/api';
import { attachmentCategory, classifyItem, effectCategory } from '../compendium/itemClassification';

export function AttachmentCategoryControl({ base, item }: { base: Tooltip; item: Item }) {
  const user = useAuthStore((state) => state.user);
  const { drafts, hydrated, updateDraft } = useDraftStore((state) => state);
  const saving = useSaveState((state) => state.locked);
  const next = drafts[base.hash]?.next ?? base;
  const classification = classifyItem(item, next);
  if (classification?.categoryId !== attachmentCategory) return null;
  const allowed =
    !!apiUrl && hydrated && !saving && (user?.role === 'editor' || user?.role === 'maintainer');
  return (
    <div>
      <button
        type="button"
        disabled={!allowed}
        onClick={() => {
          if (allowed)
            updateDraft(base, (tooltip) => ({
              ...tooltip,
              custom: {
                name: tooltip.custom?.name ?? item.name,
                categoryId: effectCategory,
              },
            }));
        }}
      >
        Move to Attachment Effects
      </button>
      <small>
        Requires a tooltip. This creates a category draft; use the normal save flow. Editor role or
        higher required.
      </small>
    </div>
  );
}
