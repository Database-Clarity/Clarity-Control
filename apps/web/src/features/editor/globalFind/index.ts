export interface FindEntry {
  hash: number;
  name: string;
  categoryId: string;
  category: string;
  lang: string;
  text: string;
}
export interface FindOptions {
  search: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  raw: boolean;
  categoryId?: string;
}
export interface FindResult extends Omit<FindEntry, 'text'> {
  from: number;
  to: number;
  line: number;
  snippet: string;
  markFrom: number;
  markTo: number;
  matched: string;
  raw: boolean;
}
export const resultLimit = 100;

/** Context is word-bounded, with explicit truncation and offsets into the displayed text. */
export function snippetFor(text: string, from: number, to: number) {
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const nextLine = text.indexOf('\n', to);
  const lineEnd = nextLine < 0 ? text.length : nextLine;
  let start = Math.max(lineStart, from - 55);
  let end = Math.min(lineEnd, to + 100);
  if (start > lineStart && !/\s/.test(text[start - 1])) {
    const boundary = text.slice(start, from).search(/\s/);
    start = boundary < 0 ? from : start + boundary + 1;
  }
  if (end < lineEnd && !/\s/.test(text[end])) {
    const context = text.slice(to, end);
    const boundary = context.search(/\s+\S*$/);
    end = boundary < 0 ? to : to + boundary;
  }
  // Tags are masked only for matching. Collapse them and whitespace in displayed context.
  const clean = (part: string) => part.replace(/\0/g, '').replace(/\s+/g, ' ');
  const before = (start > lineStart ? '…' : '') + clean(text.slice(start, from));
  const match = clean(text.slice(from, to));
  const after = clean(text.slice(to, end)) + (end < lineEnd ? '…' : '');
  return {
    snippet: before + match + after,
    markFrom: before.length,
    markTo: before.length + match.length,
  };
}

/** Mask tags without changing UTF-16 offsets, so selections address the authored document. */
export function searchableText(text: string, raw: boolean): string {
  return raw ? text : text.replace(/<[^>]*>/g, (tag) => tag.replace(/[^\n]/g, '\0'));
}

export class FindIndex {
  private entries = new Map<number, { entry: FindEntry; visible: string }>();

  update(entries: FindEntry[], removed: number[] = []) {
    for (const hash of removed) this.entries.delete(hash);
    for (const entry of entries)
      this.entries.set(entry.hash, { entry, visible: searchableText(entry.text, false) });
  }

  query(options: FindOptions): { results: FindResult[]; capped: boolean } {
    const results: FindResult[] = [];
    if (!options.search) return { results, capped: false };
    const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(
      options.wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped,
      options.caseSensitive ? 'gu' : 'giu',
    );
    for (const { entry, visible } of this.entries.values()) {
      if (options.categoryId !== undefined && entry.categoryId !== options.categoryId) continue;
      const text = options.raw ? entry.text : visible;
      for (const match of text.matchAll(expression)) {
        const from = match.index;
        const to = from + match[0].length;
        if (results.length === resultLimit) return { results, capped: true };
        const { text: _text, ...metadata } = entry;
        void _text;
        results.push({
          ...metadata,
          from,
          to,
          line: text.slice(0, from).split('\n').length,
          ...snippetFor(text, from, to),
          matched: entry.text.slice(from, to),
          raw: options.raw,
        });
      }
    }
    return { results, capped: false };
  }
}
