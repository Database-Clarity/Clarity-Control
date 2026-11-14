import {
  enhancedArrowMarkup,
  findElementTags,
  hasDelimitedMarkup,
  type Lang,
  type Tooltip,
} from '@clarity/core';
import publisherConfig from '../../../config/publisher.json';
import { HttpError } from './http.js';

const reservedMarker = /[\uE000\uE001]/;

/** The data-head file that names the installed publisher build and what it can do. */
export const publisherPinPath = '.publisher/PIN';
/** The PIN capability of a publisher build whose exportLegacy lowers element-tagged text. */
export const elementTagsCapability = 'elementTags';
/**
 * The PIN capability of a publisher build whose exportLegacy lowers delimited variables (`#{d}`)
 * and the arrow symbol (`<enhanced/>`) to today's `#d` and `#e` (core braces.ts).
 */
export const delimitedMarkupCapability = 'delimitedMarkup';

/**
 * Which exporter is live. While the publisher switch is off, the live export is this Worker's own
 * push-live, built from the same core as these guards, so it lowers element-tagged text. Once it is
 * on, the publisher installed in the data branch exports, and only a build whose PIN declares the
 * capability lowers. A getter, so the Worker tests can turn the switch on.
 */
export const exporter = {
  publisherEnabled: (): boolean => publisherConfig.enabled,
};

/** Whether a data-head `.publisher/PIN` value declares that its build lowers element tags. */
export function pinLowersElementTags(pin: unknown): boolean {
  const capabilities = (pin as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(elementTagsCapability);
}

/** Whether a data-head `.publisher/PIN` value declares that its build lowers `#{d}` and `<enhanced/>`. */
export function pinLowersDelimitedMarkup(pin: unknown): boolean {
  const capabilities = (pin as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(delimitedMarkupCapability);
}

/** The first language of `tooltip` holding `#{name}` or `<enhanced/>`. */
function firstDelimited(tooltip: Tooltip) {
  for (const [lang, entry] of Object.entries(tooltip.text) as [Lang, { text: string }][]) {
    if (!hasDelimitedMarkup(entry.text)) continue;
    const text = /#\{[a-zA-Z0-9]+\}/.exec(entry.text)?.[0] ?? enhancedArrowMarkup;
    return { lang, text };
  }
  return undefined;
}

export function hasDelimitedText(tooltip: Tooltip): boolean {
  return firstDelimited(tooltip) !== undefined;
}

/** Whether the tooltip holds an authoring form an exporter has to lower (tags, `#{d}`, `<enhanced/>`). */
export function needsLowering(tooltip: Tooltip): boolean {
  return hasTaggedText(tooltip) || hasDelimitedText(tooltip);
}

/**
 * Server guard for `#{name}` and `<enhanced/>`: accepted whenever the ACTIVE exporter lowers them
 * (always while push-live exports; once the publisher is on, only a build whose PIN declares
 * `delimitedMarkup`). Unlowered, today's apps would print `#{d}` and drop the arrow.
 */
export function refuseUnlowerableDelimited(tooltip: Tooltip, lowers: boolean, action: string): void {
  if (lowers) return;
  const found = firstDelimited(tooltip);
  if (!found) return;
  throw new HttpError(
    422,
    `Tooltip ${tooltip.hash} (${found.lang}) contains "${found.text}", which can't be ${action}: the publisher installed in the data branch does not lower it yet (${publisherPinPath} lacks the "${delimitedMarkupCapability}" capability). Write #name or #e for now.`,
  );
}

/**
 * Both guards against one PIN value (`undefined` while push-live exports, which always lowers).
 */
export function refuseUnlowerable(
  tooltip: Tooltip,
  pin: { value: unknown } | undefined,
  action: string,
): void {
  refuseUnlowerableTags(tooltip, pin === undefined || pinLowersElementTags(pin.value), action);
  refuseUnlowerableDelimited(
    tooltip,
    pin === undefined || pinLowersDelimitedMarkup(pin.value),
    action,
  );
}

/** The first language of `tooltip` holding a tagged span, with that span. */
function firstTag(tooltip: Tooltip) {
  for (const [lang, entry] of Object.entries(tooltip.text) as [Lang, { text: string }][]) {
    const [tag] = findElementTags(entry.text);
    if (tag) return { lang, tag, text: entry.text.slice(tag.from, tag.to) };
  }
  return undefined;
}

export function hasTaggedText(tooltip: Tooltip): boolean {
  return firstTag(tooltip) !== undefined;
}

/** Authored U+E000/U+E001 are always refused: the preview reserves them for tagged text. */
export function refuseReservedMarkers(tooltip: Tooltip): void {
  for (const [lang, entry] of Object.entries(tooltip.text) as [Lang, { text: string }][]) {
    if (reservedMarker.test(entry.text))
      throw new HttpError(
        422,
        `Tooltip ${tooltip.hash} (${lang}) contains the private-use character U+E000 or U+E001, which the preview reserves for element-tagged text; remove it.`,
      );
  }
}

/**
 * Server guard (concept B): element-tagged text (`<solar Scorch />`) is refused only while the
 * ACTIVE exporter cannot lower it to today's `<solar/>Scorch`; unlowered, today's apps would show
 * only the icon and drop the text. `lowers` is that exporter's answer (see `exporter`). Checked on
 * the merged tooltip, so a tag in any language counts, including one already at the head.
 */
export function refuseUnlowerableTags(tooltip: Tooltip, lowers: boolean, action: string): void {
  refuseReservedMarkers(tooltip);
  if (lowers) return;
  const found = firstTag(tooltip);
  if (!found) return;
  throw new HttpError(
    422,
    `Tooltip ${tooltip.hash} (${found.lang}) contains element-tagged text "${found.text}", which can't be ${action}: the publisher installed in the data branch does not lower it yet (${publisherPinPath} lacks the "${elementTagsCapability}" capability). Write "<${found.tag.element}/>${found.tag.text}" for now.`,
  );
}

/**
 * Fail closed on the export itself: no exported string may carry a tagged span, a marker, a
 * delimited variable, or the arrow symbol.
 */
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
    if (strings(entry).some(hasDelimitedMarkup))
      throw new HttpError(422, `The export of tooltip ${hash} still holds #{name} or <enhanced/>`);
  }
}
