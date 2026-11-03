import { languages, resolveConflictMarkers, type Tooltip } from '@clarity/core';
import type { Drafts } from '../../services/draftStorage';

/** The text a preview shows while conflict blocks remain: "mine" everywhere. */
export function previewText(text: string): string {
  return resolveConflictMarkers(text, 'mine');
}

function hasMarkers(tooltip: Tooltip): boolean {
  return languages.some((lang) => (tooltip.text[lang]?.text ?? '').includes('<<<<<<<'));
}

/** The drafts with every marker block resolved to "mine", for previews and shared globals. */
export function previewDrafts(drafts: Drafts): Drafts {
  let out: Drafts | undefined;
  for (const [key, draft] of Object.entries(drafts)) {
    if (!hasMarkers(draft.next)) continue;
    const text: Tooltip['text'] = {};
    for (const lang of languages) {
      const entry = draft.next.text[lang];
      if (entry) text[lang] = { ...entry, text: previewText(entry.text) };
    }
    out ??= { ...drafts };
    out[key] = { base: draft.base, next: { ...draft.next, text } };
  }
  return out ?? drafts;
}
