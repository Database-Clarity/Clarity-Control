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
        const start = Math.max(text.lastIndexOf('\n', from - 1) + 1, from - 55);
        const endOfLine = text.indexOf('\n', to);
        const end = Math.min(endOfLine < 0 ? text.length : endOfLine, to + 100);
        const { text: _text, ...metadata } = entry;
        void _text;
        results.push({
          ...metadata,
          from,
          to,
          line: text.slice(0, from).split('\n').length,
          snippet: text.slice(start, end).replace(/\0/g, ' '),
          markFrom: from - start,
          markTo: to - start,
          matched: entry.text.slice(from, to),
          raw: options.raw,
        });
      }
    }
    return { results, capped: false };
  }
}
