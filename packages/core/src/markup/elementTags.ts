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
  return lower(text, '', '');
}

/**
 * Tagged text the preview draws without the tint (icon kept): text holding arithmetic or a native
 * pair (`$`, braces), a variable or a nested tag through one (`#`), or a comment delimiter, also
 * one the text after the tag would complete. Element tags wrap keywords; these are edge cases.
 */
const unsafeTint = /[#${}]|\/\*|\*\/|\/\/|[/*]$/;

function lower(text: string, open: string, close: string): string {
  const tags = findElementTags(text);
  if (!tags.length) return text;
  let lowered = '';
  let at = 0;
  for (const tag of tags) {
    const [, lead, body, trail] = /^(\s*)([^]*?)(\s*)$/.exec(tag.text)!;
    const [o, c] = unsafeTint.test(body) ? ['', ''] : [open, close];
    lowered += `${text.slice(at, tag.from)}<${tag.element}/>${lead}${o}${body}${c}${trail}`;
    at = tag.to;
  }
  return lowered + text.slice(at);
}

/**
 * Preview markers around the text of a lowered tagged span (private-use characters that occur in
 * no editor-data, generator, or Compendium text). The parser renders exactly the lowered form and
 * tints what lies between them, then drops them: they never reach a span, the saved text, or an
 * export. Authored text that contains them is refused (see parseMarkup).
 */
export const elementTextOpen = '\uE000';
export const elementTextClose = '\uE001';
export const elementTextMarkers = /[\uE000\uE001]/g;

const marked = new Map<string, string>();
/** `<solar Scorch />` becomes `<solar/>` + open + `Scorch` + close; preview parsing only. */
export function markElementTags(text: string): string {
  let result = marked.get(text);
  if (result === undefined) {
    result = lower(text, elementTextOpen, elementTextClose);
    // Global variables and titles are re-read on every keystroke; keep recent documents.
    if (marked.size >= 256) marked.delete(marked.keys().next().value!);
    marked.set(text, result);
  }
  return result;
}

/**
 * A markup-only edit: element tags added, changed, or removed (`<solar/>Scorch` and
 * `<solar Scorch />`) while the lowered text, what every consumer reads, stays exactly the same.
 */
export function isMarkupOnly(before: string | undefined, after: string): boolean {
  return (
    before !== undefined && before !== after && lowerElementTags(before) === lowerElementTags(after)
  );
}

/** Whether the preview draws a tagged span's text in the element tint (see `unsafeTint`). */
export function elementTextTinted(text: string): boolean {
  return !unsafeTint.test(text.trim());
}
