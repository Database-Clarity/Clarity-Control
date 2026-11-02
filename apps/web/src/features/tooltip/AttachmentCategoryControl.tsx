import { useState } from 'react';
import type { Tooltip } from '@clarity/core';
import type { Item } from '../../services/generator';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import { apiUrl } from '../../services/api';
import {
  attachmentCategory,
  categoryLabel,
  classifyItem,
  effectCategory,
} from '../compendium/itemClassification';
import styles from './TooltipPage.module.scss';

export function promoteTooltip(tooltip: Tooltip, item: Pick<Item, 'name'>): Tooltip {
  return {
    ...tooltip,
    custom: { name: tooltip.custom?.name ?? item.name, categoryId: effectCategory },
  };
}
/** Undo a promotion so the saved file is exactly what it was before (no stray `custom`). */
export function demoteTooltip(tooltip: Tooltip, saved: Tooltip): Tooltip {
  const { custom, ...rest } = tooltip;
  if (!custom) return tooltip;
  if (!saved.custom) return rest;
  const previous = saved.custom.categoryId;
  return {
    ...rest,
    custom: { ...custom, categoryId: previous === effectCategory ? attachmentCategory : previous },
  };
}
export function hasAuthoredText(tooltip: Tooltip): boolean {
  return Object.values(tooltip.text).some((entry) => !!entry?.text.trim());
}

export function AttachmentCategoryControl({ base, item }: { base: Tooltip; item: Item }) {
  const user = useAuthStore((state) => state.user);
  const { drafts, hydrated, updateDraft } = useDraftStore((state) => state);
  const saving = useSaveState((state) => state.locked);
  const [confirming, setConfirming] = useState(false);
  const next = drafts[base.hash]?.next ?? base;
  const classification = classifyItem(item, next);
  if (
    classification?.categoryId !== attachmentCategory &&
    classification?.categoryId !== effectCategory
  )
    return null;
  const isEffect = classification.categoryId === effectCategory;
  const canEdit =
    !!apiUrl && hydrated && !saving && (user?.role === 'editor' || user?.role === 'maintainer');
  // Only an editor promotion (custom.categoryId) can be moved back; owner/manifest effects stay.
  const canDemote = canEdit && next.custom?.categoryId === effectCategory;
  const choose = (target: string) => {
    if (target === effectCategory && !isEffect && canEdit) {
      setConfirming(false);
      updateDraft(base, (tooltip) => promoteTooltip(tooltip, item));
    } else if (target === attachmentCategory && isEffect && canDemote) {
      if (hasAuthoredText(next)) setConfirming(true);
      else updateDraft(base, (tooltip) => demoteTooltip(tooltip, base));
    }
  };
  const options = [
    { id: attachmentCategory, disabled: isEffect ? !canDemote : !canEdit },
    { id: effectCategory, disabled: !canEdit },
  ];
  return (
    <div>
      <div role="group" aria-label="Attachment category" className={styles.categorySwitch}>
        {options.map(({ id, disabled }) => {
          const selected = (id === effectCategory) === isEffect;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => choose(id)}
            >
              {categoryLabel(id)} {id === attachmentCategory ? '(no tooltip)' : '(needs tooltip)'}
            </button>
          );
        })}
      </div>
      {confirming && (
        <div role="alert">
          <p>Text is kept but this item will no longer be listed as needing a tooltip.</p>
          <button
            type="button"
            disabled={!canDemote}
            onClick={() => {
              setConfirming(false);
              updateDraft(base, (tooltip) => demoteTooltip(tooltip, base));
            }}
          >
            Move to {categoryLabel(attachmentCategory)}
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
      <small>
        This creates a category draft; use the normal save flow. Editor role or higher required.
        {isEffect && !canDemote && canEdit ? ' Only editor promotions can be moved back.' : ''}
      </small>
    </div>
  );
}
