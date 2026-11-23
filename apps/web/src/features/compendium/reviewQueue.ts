import { isSetSelector } from './itemClassification';
import {
  isMovedInactive,
  normaliseCompendiumEnglish,
  resolveAlias,
  resolveCompendiumLink,
  type CompendiumData,
  type CompendiumLink,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import { itemFor, tooltipFor } from '../navigation/catalog';
import { sourceFingerprint, type ReviewProgress } from './reviewProgress';

/** Whether a link still resolves, and what that says about its source. */
export function linkState(link: CompendiumLink | undefined, source: CompendiumData) {
  if (!link) return { valid: false, reason: 'Unlinked' as const };
  const resolution = resolveCompendiumLink(link, source);
  if (!('row' in resolution)) return { valid: false, reason: 'Needs repair' as const };
  return { valid: true, reason: resolution.changed ? ('Changed' as const) : ('Linked' as const) };
}

/**
 * What a local decision was made about: the entry itself. Sheet content is not part of it, so a
 * Compendium refresh never reopens the decision.
 */
export function entryEvidence({
  name,
  category,
  base,
}: Pick<Evidence, 'name' | 'category' | 'base'>) {
  return `entry:${sourceFingerprint([
    name,
    category,
    base.text.en && { ...base.text.en, text: normaliseCompendiumEnglish(base.text.en.text) },
    base.compendium,
  ])}`;
}
type Evidence = ReturnType<typeof reviewEvidence>[number];

export function reviewEvidence(
  editor: EditorData,
  source: CompendiumData,
  drafts: Drafts,
  fingerprint: string,
) {
  const hashes = new Set(
    [...Object.values(editor.items), ...Object.values(editor.bundle.tooltips)].map(
      (entry) => entry.hash,
    ),
  );
  return [...hashes]
    .flatMap((hash) => {
      // Enhanced tooltips can own distinct text; aliases never own a link.
      if (hash <= 3 || resolveAlias(hash, editor.aliases) !== hash) return [];
      if (isMovedInactive(hash, editor.bundle.inactiveMoves)) return [];
      const base = tooltipFor(hash, editor);
      if (base.archive) return [];
      const item = itemFor(hash, editor);
      if (item && isSetSelector(item)) return [];
      const next = drafts[hash]?.next ?? base;
      const changed = JSON.stringify(base.compendium) !== JSON.stringify(next.compendium);
      const evidence = sourceFingerprint([
        fingerprint,
        item?.name,
        item?.categoryId,
        base.text.en && { ...base.text.en, text: normaliseCompendiumEnglish(base.text.en.text) },
        base.compendium,
      ]);
      return [
        {
          hash,
          base,
          next,
          name: item?.name ?? String(hash),
          category: item?.categoryId ?? 'other',
          ...linkState(next.compendium, source),
          changed,
          evidence,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.hash - b.hash);
}

/**
 * Earlier versions recorded the whole sheet with the entry in one digest, which cannot be told
 * apart again: those decisions stay as made. Newer ones hold until the entry itself changes.
 */
function decisionHolds(fingerprint: string, entry: Parameters<typeof entryEvidence>[0]) {
  return /^\d+:\d+$/.test(fingerprint) || fingerprint === entryEvidence(entry);
}

// Local progress never changes source evidence or resolves sheet links.
export function applyReviewProgress(
  evidence: ReturnType<typeof reviewEvidence>,
  progress: ReviewProgress,
) {
  return evidence.flatMap(({ valid, changed, ...entry }) => {
    const decision = progress.decisions[entry.hash];
    const holds = !!decision && decisionHolds(decision.fingerprint, entry);
    const status = valid
      ? changed
        ? ('drafted' as const)
        : ('saved' as const)
      : holds
        ? decision.kind
        : ('open' as const);
    if (status === 'saved' && !decision && !changed) return [];
    // `stale`: the entry itself changed since its local decision, so the matcher stays cautious.
    return [{ ...entry, status, stale: !valid && !!decision && !holds }];
  });
}

export function reviewQueue(
  editor: EditorData,
  source: CompendiumData,
  drafts: Drafts,
  progress: ReviewProgress,
  fingerprint: string,
) {
  return applyReviewProgress(reviewEvidence(editor, source, drafts, fingerprint), progress);
}

export function mayDraftLink(
  role: string | null | undefined,
  api: boolean,
  hydrated: boolean,
  locked: boolean,
) {
  return api && hydrated && !locked && !!role && ['maintainer', 'editor', 'trial'].includes(role);
}
