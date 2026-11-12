import { findElementTags, type Lang, type Tooltip } from '@clarity/core';
import { HttpError } from './http.js';

/**
 * Save hold: element-tagged text (`<solar Scorch />`) is refused until both exporters lower it to
 * today's `<solar/>Scorch`; unlowered, today's apps show only the icon and drop the text. Checked
 * on the merged tooltip, so a tag in any language is refused, including one already at the head
 * in a language this change does not edit. The editor shows the same reason (core validation).
 */
export function refuseElementTags(tooltip: Tooltip): void {
  for (const [lang, entry] of Object.entries(tooltip.text) as [Lang, { text: string }][]) {
    const [tag] = findElementTags(entry.text);
    if (!tag) continue;
    throw new HttpError(
      422,
      `Tooltip ${tooltip.hash} (${lang}) contains element-tagged text "${entry.text.slice(tag.from, tag.to)}", which can't be saved yet: apps would show only the icon. Write "<${tag.element}/>${tag.text}" for now.`,
    );
  }
}
