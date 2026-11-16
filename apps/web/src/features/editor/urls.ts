/**
 * Web addresses in tooltip text: bare URLs and the target of `<link Text [url] />`. Only http and
 * https are ever found, so other schemes (javascript:, data:, mailto:) can never be opened.
 */
const urlPattern = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const closers: Record<string, string> = { ')': '(', ']': '[' };

/**
 * Sentence punctuation after a URL ("see https://x.y/a.") is not part of it, nor is an unmatched
 * closing bracket: the `]` ending `<link Text [url] />`, or ")" around "(see https://x.y)".
 * Matched ones stay ("?ids[]=1", "https://[::1]/", "A_(b)").
 */
function trimEnd(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last && '.,;:!?'.includes(last)) end--;
    else if (last && last in closers && count(url, closers[last]!, end) < count(url, last, end))
      end--;
    else return url.slice(0, end);
  }
}

function count(text: string, char: string, end: number): number {
  let n = 0;
  for (let i = 0; i < end; i++) if (text[i] === char) n++;
  return n;
}

export interface UrlRange {
  from: number;
  to: number;
  url: string;
}

/** The http(s) URL covering `offset` in `line`, with line-relative offsets. */
export function urlInLine(line: string, offset: number): UrlRange | null {
  for (const match of line.matchAll(urlPattern)) {
    const from = match.index;
    if (from > offset) return null;
    const url = trimEnd(match[0]);
    if (offset <= from + url.length && /^https?:\/\/[^/?#]/i.test(url))
      return { from, to: from + url.length, url };
  }
  return null;
}

/** Opens `url` in a new tab with no opener or referrer; anything but http(s) is refused. */
export function openUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
  return true;
}
