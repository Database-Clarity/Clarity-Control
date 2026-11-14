import {
  enhancedArrowMarkup,
  findElementTags,
  hasDelimitedMarkup,
  reservedNameMessage,
  reservedNames,
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
export const markupBracesCapability = 'markupBraces';
/**
 * The PIN capability of a publisher build whose exportLegacy also lowers Prismatic-tagged text
 * (`<prismatic Transcendence />`). Prismatic joined the element tags after builds declaring
 * `elementTags` shipped; such a build leaves the span unlowered and the consumers drop its text.
 */
export const prismaticTagsCapability = 'prismaticTags';

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
export function pinLowersMarkupBraces(pin: unknown): boolean {
  const capabilities = (pin as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(markupBracesCapability);
}

/** Whether a data-head `.publisher/PIN` value declares that its build lowers Prismatic tags too. */
export function pinLowersPrismaticTags(pin: unknown): boolean {
  const capabilities = (pin as { capabilities?: unknown } | null)?.capabilities;
  return (
    Array.isArray(capabilities) &&
    capabilities.includes(elementTagsCapability) &&
    capabilities.includes(prismaticTagsCapability)
  );
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
 * `markupBraces`). Unlowered, today's apps would print `#{d}` and drop the arrow.
 */
export function refuseUnlowerableDelimited(
  tooltip: Tooltip,
  lowers: boolean,
  action: string,
): void {
  refuseReservedNames(tooltip);
  if (lowers) return;
  const found = firstDelimited(tooltip);
  if (!found) return;
  throw new HttpError(
    422,
    `Tooltip ${tooltip.hash} (${found.lang}) contains "${found.text}", which can't be ${action}: the publisher installed in the data branch does not lower it yet (${publisherPinPath} lacks the "${markupBracesCapability}" capability). Write #name or #e for now.`,
  );
}

/**
 * Variable names starting like a brace holder (`Zb1w…`, core braces.ts) are refused whatever the
 * exporter: one would take a holder's place in every tooltip that writes `#{d}x`.
 */
export function refuseReservedNames(tooltip: Tooltip): void {
  for (const [lang, entry] of Object.entries(tooltip.text) as [Lang, { text: string }][]) {
    const [found] = reservedNames(entry.text);
    if (found)
      throw new HttpError(
        422,
        `Tooltip ${tooltip.hash} (${lang}): ${reservedNameMessage(found.name)}`,
      );
  }
}

/**
 * Both guards against one PIN value (`undefined` while push-live exports, which always lowers).
 */
export function refuseUnlowerable(
  tooltip: Tooltip,
  pin: { value: unknown } | undefined,
  action: string,
): void {
  refuseUnlowerableTags(
    tooltip,
    pin === undefined || pinLowersElementTags(pin.value),
    action,
    pin === undefined || pinLowersPrismaticTags(pin.value),
  );
  refuseUnlowerableDelimited(
    tooltip,
    pin === undefined || pinLowersMarkupBraces(pin.value),
    action,
  );
}

/** The first language of `tooltip` holding a tagged span (of `element` only, if given), with it. */
function firstTag(tooltip: Tooltip, element?: string) {
  for (const [lang, entry] of Object.entries(tooltip.text) as [Lang, { text: string }][]) {
    const tag = findElementTags(entry.text).find((found) => !element || found.element === element);
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
 * `lowersPrismatic` is the same answer for Prismatic tags, which older `elementTags` builds miss.
 */
export function refuseUnlowerableTags(
  tooltip: Tooltip,
  lowers: boolean,
  action: string,
  lowersPrismatic = lowers,
): void {
  refuseReservedMarkers(tooltip);
  if (lowers && lowersPrismatic) return;
  const found = lowers ? firstTag(tooltip, 'prismatic') : firstTag(tooltip);
  if (!found) return;
  const capability = lowers ? prismaticTagsCapability : elementTagsCapability;
  throw new HttpError(
    422,
    `Tooltip ${tooltip.hash} (${found.lang}) contains element-tagged text "${found.text}", which can't be ${action}: the publisher installed in the data branch does not lower it yet (${publisherPinPath} lacks the "${capability}" capability). Write "<${found.tag.element}/>${found.tag.text}" for now.`,
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
