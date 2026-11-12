import {
  findElementTags,
  markupImports,
  resolveAlias,
  type Aliases,
  type Lang,
  type Tooltip,
} from '@clarity/core';
import { HttpError } from './http.js';

const reservedMarker = /[\uE000\uE001]/;

function refuse(tooltip: Tooltip, action: string): void {
  for (const [lang, entry] of Object.entries(tooltip.text) as [Lang, { text: string }][]) {
    if (reservedMarker.test(entry.text))
      throw new HttpError(
        422,
        `Tooltip ${tooltip.hash} (${lang}) contains the private-use character U+E000 or U+E001, which the preview reserves for element-tagged text; remove it.`,
      );
    const [tag] = findElementTags(entry.text);
    if (!tag) continue;
    throw new HttpError(
      422,
      `Tooltip ${tooltip.hash} (${lang}) contains element-tagged text "${entry.text.slice(tag.from, tag.to)}", which can't be ${action} yet: apps would show only the icon. Write "<${tag.element}/>${tag.text}" for now.`,
    );
  }
}

/**
 * Save hold: element-tagged text (`<solar Scorch />`) is refused until both exporters lower it to
 * today's `<solar/>Scorch`; unlowered, today's apps show only the icon and drop the text. Checked
 * on the merged tooltip, so a tag in any language is refused, including one already at the head
 * in a language this change does not edit. The editor shows the same reason (core validation).
 */
export function refuseElementTags(tooltip: Tooltip): void {
  refuse(tooltip, 'saved');
}

/**
 * Export hold (push-live): a pushed tooltip, or a document its text reads (imports, nested and
 * aliased, `global`, the global variables 2 and titles 3), must not hold a tagged span, however
 * it got into the data. Uses the documents the base/enhanced check already loaded: no I/O.
 */
export function refuseTaggedExport(
  roots: readonly number[],
  documents: ReadonlyMap<number, Tooltip>,
  aliases: Aliases,
): void {
  const visited = new Set<number>();
  const pending = [...roots, 2, 3];
  while (pending.length) {
    const hash = resolveAlias(pending.pop()!, aliases);
    if (visited.has(hash)) continue;
    visited.add(hash);
    const tooltip = documents.get(hash);
    if (!tooltip) continue;
    refuse(tooltip, 'pushed');
    for (const entry of Object.values(tooltip.text)) {
      for (const line of markupImports(entry?.text ?? '')) {
        const from = line.match(/ from (\d+|global) *$/)?.[1];
        if (from) pending.push(from === 'global' ? 1 : Number(from));
      }
    }
  }
}

/** Fail closed on the export itself: no exported string may carry a tagged span or a marker. */
export function refuseTaggedEntries(entries: Record<string, unknown>): void {
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];
  for (const [hash, entry] of Object.entries(entries)) {
    if (strings(entry).some((text) => reservedMarker.test(text) || findElementTags(text).length))
      throw new HttpError(422, `The export of tooltip ${hash} still holds element-tagged text`);
  }
}
