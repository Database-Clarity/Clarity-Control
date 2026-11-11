import { EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';

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
  private entries = new Map<
    number,
    {
      entry: FindEntry;
      raw: EditorState;
      visible: EditorState;
      visibleText: string;
      tags: { from: number; to: number }[];
    }
  >();

  update(entries: FindEntry[], removed: number[] = []) {
    for (const hash of removed) this.entries.delete(hash);
    for (const entry of entries) {
      // The actual editor normalizes line separators on load. Keep its document offsets,
      // including when an external source still contains CRLF or lone CR characters.
      const raw = EditorState.create({ doc: entry.text });
      const text = raw.doc.toString();
      const visibleText = searchableText(text, false);
      this.entries.set(entry.hash, {
        entry: { ...entry, text },
        raw,
        visible: visibleText === text ? raw : EditorState.create({ doc: visibleText }),
        visibleText,
        tags: [...text.matchAll(/<[^>]*>/g)].map((tag) => ({
          from: tag.index,
          to: tag.index + tag[0].length,
        })),
      });
    }
  }

  query(options: FindOptions): { results: FindResult[]; capped: boolean } {
    const results: FindResult[] = [];
    if (!options.search) return { results, capped: false };
    // Reuse the widget's literal matcher, normalization, escaping, and word boundaries.
    // These states and cursors live exclusively in the search worker.
    const query = new SearchQuery({
      search: options.search,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
    });
    for (const { entry, raw, visible, visibleText, tags } of this.entries.values()) {
      if (options.categoryId !== undefined && entry.categoryId !== options.categoryId) continue;
      const text = options.raw ? entry.text : visibleText;
      const cursor = query.getCursor(options.raw ? raw : visible);
      for (let next = cursor.next(); !next.done; next = cursor.next()) {
        const { from, to } = next.value;
        // Even a query for a newline or NUL must not find hidden tag characters.
        if (!options.raw && tags.some((tag) => from < tag.to && to > tag.from)) continue;
        if (results.length === resultLimit) return { results, capped: true };
        const { text: _text, ...metadata } = entry;
        void _text;
        results.push({
          ...metadata,
          from,
          to,
          line: raw.doc.lineAt(from).number,
          ...snippetFor(text, from, to),
          matched: entry.text.slice(from, to),
          raw: options.raw,
        });
      }
    }
    return { results, capped: false };
  }
}
