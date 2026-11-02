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

// Only an exact switch-shaped override can be removed without remembering prior identity.
// A pre-existing identical override is indistinguishable and returns to native classification.
function canSwitchCategory(tooltip: Tooltip, item: Pick<Item, 'name'>, native: string): boolean {
  const opposite = native === attachmentCategory ? effectCategory : attachmentCategory;
  return (
    [attachmentCategory, effectCategory].includes(native) &&
    (!tooltip.custom ||
      (tooltip.custom.name === item.name && tooltip.custom.categoryId === opposite))
  );
}

/** Preserve independent custom identities; remove switch overrides on return to native. */
export function setTooltipCategory(
  tooltip: Tooltip,
  item: Pick<Item, 'name'>,
  target: string,
  native: string,
): Tooltip {
  if (!canSwitchCategory(tooltip, item, native)) return tooltip;
  const { custom, ...rest } = tooltip;
  if (target === native) {
    if (!custom) return tooltip;
    return rest;
  }
  return { ...rest, custom: { name: custom?.name ?? item.name, categoryId: target } };
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
  const native = classifyItem(item)?.categoryId ?? classification.categoryId;
  const hasOwnIdentity = !canSwitchCategory(next, item, native);
  const allowed =
    !hasOwnIdentity &&
    !!apiUrl &&
    hydrated &&
    !saving &&
    (user?.role === 'editor' || user?.role === 'maintainer');
  const move = (target: string) =>
    updateDraft(base, (tooltip) => setTooltipCategory(tooltip, item, target, native));
  const choose = (target: string) => {
    if (!allowed || target === classification.categoryId) return;
    if (target === attachmentCategory && hasAuthoredText(next)) setConfirming(true);
    else {
      setConfirming(false);
      move(target);
    }
  };
  const options = [attachmentCategory, effectCategory];
  return (
    <div>
      <div role="group" aria-label="Attachment category" className={styles.categorySwitch}>
        {options.map((id) => {
          const selected = (id === effectCategory) === isEffect;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              disabled={!allowed}
              onClick={() => choose(id)}
            >
              {categoryLabel(id)} {id === attachmentCategory ? '(no tooltip)' : '(needs tooltip)'}
            </button>
          );
        })}
      </div>
      {confirming && !hasOwnIdentity && (
        <div role="alert">
          <p>Text is kept but this item will no longer be listed as needing a tooltip.</p>
          <button
            type="button"
            disabled={!allowed}
            onClick={() => {
              setConfirming(false);
              move(attachmentCategory);
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
        {hasOwnIdentity
          ? 'This item has its own custom identity; change its category in the identity editor.'
          : 'This creates a category draft; use the normal save flow. Editor role or higher required.'}
      </small>
    </div>
  );
}
