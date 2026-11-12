/**
 * Element-tagged text: `<solar Scorch />` is one of the six element icons wrapping plain text on
 * one line. It renders as the icon followed by the text in the element tint. Its lowered form,
 * the format every consumer reads today, is `<solar/>Scorch`: the icon immediately followed by
 * the text, nothing added or removed.
 *
 * A tagged span is a whole inline token as the parser splits it (`<.+?/>`, never across a line)
 * of the form `<element TEXT />`, where TEXT is not blank and holds no `<`, `|`, `[`, or `]`.
 * Any other token keeps today's meaning (a standalone icon, or the stray-tag diagnostic).
 */
export const elementTagNames = ['kinetic', 'arc', 'solar', 'void', 'stasis', 'strand'] as const;
export type ElementTagName = (typeof elementTagNames)[number];

/** The parser's inline token, one line at most (the same pattern `lines.ts` splits on). */
const inlineTokens = /<.+?\/>/g;
const taggedToken = new RegExp(`^<(${elementTagNames.join('|')}) ([^<|[\\]\\n]+) />$`);

export interface ElementTag {
  element: ElementTagName;
  text: string;
}

/** The element and text of one whole inline token, or undefined when it is not a tagged span. */
export function elementTagToken(token: string): ElementTag | undefined {
  const match = taggedToken.exec(token);
  if (!match || !match[2]!.trim()) return undefined;
  return { element: match[1] as ElementTagName, text: match[2]! };
}

/** Every tagged span in `text`, with its source range. */
export function findElementTags(text: string): (ElementTag & { from: number; to: number })[] {
  if (!text.includes(' />')) return [];
  const found: (ElementTag & { from: number; to: number })[] = [];
  for (const match of text.matchAll(inlineTokens)) {
    const tag = elementTagToken(match[0]);
    if (tag) found.push({ ...tag, from: match.index, to: match.index + match[0].length });
  }
  return found;
}

export function hasElementTags(text: string): boolean {
  return findElementTags(text).length > 0;
}

/**
 * Today's format: `<solar Scorch />` becomes `<solar/>Scorch`. Exact and idempotent; text without
 * tagged spans is returned unchanged (the same string).
 */
export function lowerElementTags(text: string): string {
  const tags = findElementTags(text);
  if (!tags.length) return text;
  let lowered = '';
  let at = 0;
  for (const tag of tags) {
    lowered += `${text.slice(at, tag.from)}<${tag.element}/>${tag.text}`;
    at = tag.to;
  }
  return lowered + text.slice(at);
}
