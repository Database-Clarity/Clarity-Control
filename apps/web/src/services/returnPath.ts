const returnPathKey = 'clarity-editor-return-path';
const maxLength = 2048;

/** Accepts only an in-app relative route; anything else falls back to `/`. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  // Control characters (including tab/newline, which browsers strip from URLs) are never valid.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  const segments = routeSegments(value.split(/[?#]/, 1)[0]);
  if (!segments) return '/';
  // The router decodes, resolves dot segments and matches case-insensitively.
  if (segments[0]?.toLowerCase() === 'auth') return '/';
  return value;
}

/**
 * The route segments React Router would match: repeated slashes collapsed, percent-decoded,
 * dot segments resolved.
 * Returns undefined for malformed or ambiguous encodings (bad percent escapes, encoded
 * slashes, backslashes or controls).
 */
function routeSegments(pathname: string): string[] | undefined {
  const segments: string[] = [];
  for (const raw of pathname.split('/').slice(1)) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    // eslint-disable-next-line no-control-regex
    if (/[/\\\u0000-\u001f\u007f]/.test(segment)) return undefined;
    // The router collapses repeated slashes before resolving dot segments.
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments;
}

/** Remember the current HashRouter location (path + search) before leaving for GitHub sign-in. */
export function rememberReturnPath(location: { pathname: string; search: string }): void {
  try {
    sessionStorage.setItem(returnPathKey, safeReturnPath(`${location.pathname}${location.search}`));
  } catch {
    // Storage may be unavailable; the user simply lands on `/` after sign-in.
  }
}

/** Read and clear the remembered location; always returns a safe in-app route. */
export function takeReturnPath(): string {
  try {
    const value = sessionStorage.getItem(returnPathKey);
    sessionStorage.removeItem(returnPathKey);
    return safeReturnPath(value);
  } catch {
    return '/';
  }
}
