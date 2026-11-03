import {
  autoLinkCompendium,
  resolveCompendiumLink,
  type CompendiumData,
  type CompendiumLink,
  type CompendiumMatch,
  type Tooltip,
} from '@clarity/core';
import type { EditorData } from '../../stores/data';
import type { ReviewProgress } from './reviewProgress';
import { confirmCompendiumSelection } from './selection';

export interface ReviewProposal {
  match?: CompendiumMatch;
  suggested?: boolean;
  link?: CompendiumLink;
  candidates: CompendiumMatch[];
}
// Only the established resolver can propose a whole-description link. Hints never enter this path.
export function proposalFor(
  base: Tooltip,
  editor: EditorData,
  source: CompendiumData,
): ReviewProposal {
  const result = autoLinkCompendium(
    base,
    editor.items,
    editor.aliases,
    source,
    source.fetchedAt,
    editor.bundle.tooltips,
  );
  const resolved = result.next?.compendium && resolveCompendiumLink(result.next.compendium, source);
  const match = resolved && 'row' in resolved ? resolved : undefined;
  const link = match && confirmCompendiumSelection(match, source);
  const existing = base.compendium && resolveCompendiumLink(base.compendium, source);
  return {
    match,
    link,
    candidates: result.candidates,
    ...(existing && existing.status === 'relink-suggested' ? { suggested: true } : {}),
  };
}
export function advanceHash(hashes: number[], index: number) {
  return hashes[index + 1] ?? hashes[index - 1];
}
export function recordDecision(
  progress: ReviewProgress,
  hash: number,
  evidence: string,
  kind: 'open' | 'skipped' | 'no-equivalent',
  next?: number,
): ReviewProgress {
  return {
    ...progress,
    selected: next,
    decisions: { ...progress.decisions, [hash]: { kind, fingerprint: evidence } },
  };
}
export function shortcutAction(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  editing: boolean,
) {
  if (editing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return undefined;
  return ({ a: 'accept', p: 'pick', n: 'none', s: 'skip', u: 'undo' } as const)[
    event.key.toLowerCase() as 'a' | 'p' | 'n' | 's' | 'u'
  ];
}
// Restore only link metadata, keeping any text/association edits made after a decision.
export function restoreLink(
  current: Tooltip,
  before: Tooltip['compendium'],
  after: Tooltip['compendium'],
) {
  if (JSON.stringify(current.compendium) !== JSON.stringify(after)) return undefined;
  const next = { ...current };
  if (before) next.compendium = before;
  else delete next.compendium;
  return next;
}
