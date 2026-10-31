import { resolveAlias, resolveCompendiumLink, type CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { Drafts } from '../../services/draftStorage';
import { itemFor, tooltipFor } from '../navigation/catalog';
import { localDecision, sourceFingerprint, type ReviewProgress } from './reviewProgress';

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
      const base = tooltipFor(hash, editor);
      const item = itemFor(hash, editor);
      const next = drafts[hash]?.next ?? base;
      const resolution = next.compendium && resolveCompendiumLink(next.compendium, source);
      const valid = resolution && !['missing', 'candidates'].includes(resolution.status);
      const changed = JSON.stringify(base.compendium) !== JSON.stringify(next.compendium);
      const evidence = sourceFingerprint([
        fingerprint,
        item?.name,
        item?.categoryId,
        base.text.en,
        base.compendium,
      ]);
      return [
        {
          hash,
          base,
          next,
          name: item?.name ?? String(hash),
          category: item?.categoryId ?? 'other',
          valid: !!valid,
          changed,
          evidence,
          reason: !next.compendium ? 'Unlinked' : valid ? 'Linked' : 'Needs repair',
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.hash - b.hash);
}

// Local progress never changes source evidence or resolves sheet links.
export function applyReviewProgress(
  evidence: ReturnType<typeof reviewEvidence>,
  progress: ReviewProgress,
) {
  return evidence.flatMap(({ valid, changed, ...entry }) => {
    const status = valid
      ? changed
        ? ('drafted' as const)
        : ('saved' as const)
      : localDecision(progress, entry.hash, entry.evidence);
    const decision = progress.decisions[entry.hash];
    if (status === 'saved' && !decision && !changed) return [];
    return [
      { ...entry, status, stale: !valid && !!decision && decision.fingerprint !== entry.evidence },
    ];
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
