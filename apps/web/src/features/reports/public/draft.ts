import { resolveReportAnchor } from '../../../../../../packages/core/src/reports/displayText';
import type {
  ReportAnchor,
  ReportSubmission,
} from '../../../../../../packages/core/src/reports/schemas';
import type { RenderLine } from './tooltipRender';

export type ReportCategory = ReportSubmission['category'];
export const categoryLabels: Record<ReportCategory, string> = {
  'wrong-value': 'Wrong value',
  outdated: 'Outdated',
  wording: 'Typo or wording',
  translation: 'Translation',
  missing: 'Missing information',
  other: 'Other',
};
export const maxNotes = 5;
export const maxNoteLength = 500;
export const maxOverallLength = 1000;

/** A marked range of the display text. */
export interface Mark {
  start: number;
  end: number;
}
export interface DraftNote {
  id: string;
  category: ReportCategory;
  text: string;
  /** Marked text; null = Whole tooltip. */
  mark: Mark | null;
  /** A quote whose mark was lost (language switch, or text changed while signing in). */
  remark?: string;
}
export interface ReportDraft {
  lang: string;
  notes: DraftNote[];
  overall: string;
  source: string;
  links: string[];
  /** The quote anchors of the notes, kept so a restored draft can re-anchor by quote. */
  anchors?: Record<string, ReportAnchor>;
  /** Set before the first send and reused for retries of the same payload. */
  pending?: { requestId: string; secret: string; payload: string };
}

export const emptyDraft = (lang: string): ReportDraft => ({
  lang,
  notes: [],
  overall: '',
  source: '',
  links: [''],
});

let counter = 0;
export const noteId = () => `n${Date.now().toString(36)}${(counter++).toString(36)}`;

export const defaultCategory = (lang: string): ReportCategory =>
  lang === 'en' ? 'wrong-value' : 'translation';

const overlaps = (a: Mark, b: Mark) => a.start < b.end && b.start < a.end;

/**
 * Marks `range`: a range overlapping existing marks merges into the earliest of them (their note
 * texts joined), anything else becomes a new note while fewer than five exist.
 */
export function markRange(
  notes: DraftNote[],
  range: Mark,
  lang: string,
  /** The Re-mark note to reconnect; otherwise the first one waits for this mark. */
  target?: string,
): { notes: DraftNote[]; id?: string; added: boolean; reconnected?: boolean } {
  if (range.end <= range.start) return { notes, added: false };
  const hit = notes.filter((note) => note.mark && overlaps(note.mark, range));
  if (!hit.length) {
    // A note whose text changed under it (locale switch, new data) takes the next fresh mark,
    // keeping its explanation; this works at the five-note cap too.
    const waiting = notes.filter((note) => !note.mark && note.remark);
    const reconnect = waiting.find((note) => note.id === target) ?? waiting[0];
    if (reconnect)
      return {
        notes: notes.map((note) =>
          note === reconnect ? { ...note, mark: range, remark: undefined } : note,
        ),
        id: reconnect.id,
        added: false,
        reconnected: true,
      };
    if (notes.length >= maxNotes) return { notes, added: false };
    const note: DraftNote = {
      id: noteId(),
      category: defaultCategory(lang),
      text: '',
      mark: range,
    };
    return { notes: [...notes, note], id: note.id, added: true };
  }
  const [first, ...rest] = hit;
  const merged: Mark = {
    start: Math.min(range.start, ...hit.map((note) => note.mark!.start)),
    end: Math.max(range.end, ...hit.map((note) => note.mark!.end)),
  };
  const text = [first.text, ...rest.map((note) => note.text)].filter((t) => t.trim()).join(' ');
  const next = notes
    .filter((note) => !rest.includes(note))
    .map((note) => (note === first ? { ...note, mark: merged, text } : note));
  return { notes: next, id: first.id, added: false };
}

/** The word (letters, digits, and number punctuation such as "7.5%") around offset `at`. */
export function wordAt(display: string, line: RenderLine, at: number): Mark | undefined {
  const word = /[\p{L}\p{N}%+'’.,-]/u;
  let start = Math.min(Math.max(at, line.start), line.end);
  let end = start;
  while (start > line.start && word.test(display[start - 1])) start--;
  while (end < line.end && word.test(display[end])) end++;
  // Trailing sentence punctuation is not part of the word ("Breaches:" → "Breaches").
  while (end > start && /[.,]/.test(display[end - 1])) end--;
  while (start < end && /[.,'’-]/.test(display[start])) start++;
  return end > start ? { start, end } : undefined;
}

/** The words of a line, in order (keyboard narrowing steps through them). */
export function wordsOf(display: string, line: RenderLine): Mark[] {
  const words: Mark[] = [];
  for (let at = line.start; at < line.end;) {
    const word = wordAt(display, line, at);
    if (word && word.start >= at) {
      words.push(word);
      at = word.end + 1;
    } else at++;
  }
  return words;
}

/** The marked range without the line's leading and trailing spaces (a whole line as a quote). */
export function lineMark(display: string, line: RenderLine): Mark | undefined {
  let { start, end } = line;
  // A list bullet is layout, not wording: the quote starts at the first word.
  while (start < end && /[\s•·*–-]/.test(display[start])) start++;
  while (end > start && /\s/.test(display[end - 1])) end--;
  return end > start ? { start, end } : undefined;
}

export const isWholeLine = (display: string, line: RenderLine, mark: Mark | null) => {
  const whole = lineMark(display, line);
  return Boolean(mark && whole && mark.start === whole.start && mark.end === whole.end);
};

/** The W3C quote + position selector for a mark over `display`. */
export function anchorFor(
  display: string,
  rev: string,
  lines: RenderLine[],
  mark: Mark,
): ReportAnchor {
  return {
    rev,
    exact: display.slice(mark.start, mark.end),
    prefix: display.slice(Math.max(0, mark.start - 32), mark.start),
    suffix: display.slice(mark.end, mark.end + 32),
    start: mark.start,
    end: mark.end,
    line: Math.max(
      0,
      lines.findIndex((line) => mark.start >= line.start && mark.start <= line.end),
    ),
  };
}

/**
 * Re-applies a restored draft to the current display text: marks re-anchor by quote (exact, then
 * moved); a mark that no longer resolves keeps its note with a "Re-mark" quote.
 */
export function reanchorDraft(draft: ReportDraft, display: string, rev: string): ReportDraft {
  const notes = draft.notes.map((note) => {
    const anchor = draft.anchors?.[note.id];
    if (!note.mark || !anchor) return note;
    const resolved = resolveReportAnchor(display, rev, anchor);
    return resolved.status === 'stale'
      ? { ...note, mark: null, remark: anchor.exact }
      : { ...note, mark: { start: resolved.start, end: resolved.end } };
  });
  return { ...draft, notes };
}

/** A language switch keeps every note's text but drops its mark (the text differs). */
export function dropMarks(draft: ReportDraft, display: string, lang: string): ReportDraft {
  return {
    ...draft,
    lang,
    anchors: undefined,
    pending: undefined,
    notes: draft.notes.map((note) =>
      note.mark
        ? { ...note, mark: null, remark: display.slice(note.mark.start, note.mark.end) }
        : note,
    ),
  };
}

const draftKey = (hash: number) => `clarity-report-draft:${hash}`;

/** The draft lives in this tab's sessionStorage: it survives the sign-in round trip and reloads. */
export function readDraft(hash: number): ReportDraft | undefined {
  try {
    const value = sessionStorage.getItem(draftKey(hash));
    const draft = value ? (JSON.parse(value) as ReportDraft) : undefined;
    return draft && Array.isArray(draft.notes) && typeof draft.lang === 'string'
      ? { ...emptyDraft(draft.lang), ...draft }
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeDraft(hash: number, draft: ReportDraft | undefined): void {
  try {
    if (draft) sessionStorage.setItem(draftKey(hash), JSON.stringify(draft));
    else sessionStorage.removeItem(draftKey(hash));
  } catch {
    // Storage unavailable (private mode, quota): the draft simply is not kept.
  }
}

export const isEmptyDraft = (draft: ReportDraft) =>
  !draft.notes.length &&
  !draft.overall.trim() &&
  !draft.source.trim() &&
  !draft.links.some((l) => l.trim());

const secretKey = (id: string) => `clarity-report-secret:${id}`;

/** The withdraw secret for a receipt, kept in this tab only (never in the location). */
export function rememberSecret(id: string, secret: string): void {
  try {
    sessionStorage.setItem(secretKey(id), secret);
  } catch {
    // Storage unavailable: the receipt link still carries it.
  }
}
export function storedSecret(id: string): string | undefined {
  try {
    return sessionStorage.getItem(secretKey(id)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A fresh client request id and withdraw secret (43 url-safe characters). */
export function newCapability(): { requestId: string; secret: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return { requestId: crypto.randomUUID(), secret };
}

const recentKey = 'clarity-report-recent';
export function recentItems(): number[] {
  try {
    const value = JSON.parse(localStorage.getItem(recentKey) ?? '[]') as unknown;
    return Array.isArray(value)
      ? value.filter((v): v is number => Number.isInteger(v)).slice(0, 5)
      : [];
  } catch {
    return [];
  }
}
export function rememberRecent(hash: number): void {
  try {
    localStorage.setItem(
      recentKey,
      JSON.stringify([hash, ...recentItems().filter((h) => h !== hash)].slice(0, 5)),
    );
  } catch {
    // Recent items are a convenience only.
  }
}

/** The reporter's language from the browser, as one of the data languages (English otherwise). */
export function browserLang(
  list: readonly string[] = navigator.languages ?? [navigator.language],
): string {
  for (const tag of list) {
    const lower = tag.toLowerCase();
    if (/^zh-(cn|sg|hans)/.test(lower)) return 'zh-chs';
    if (/^zh/.test(lower)) return 'zh-cht';
    if (lower === 'es-mx' || lower === 'pt-br') return lower;
    if (lower.startsWith('pt')) return 'pt-br';
    const base = lower.split('-')[0];
    if (['en', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'ru'].includes(base)) return base;
  }
  return 'en';
}
