/**
 * Failed-request messages people can read: never an HTTP body or JSON. The server's own short
 * `error` sentence is kept; the raw body stays on the error's `cause` for debugging.
 */

/** The server's `error` text (plus any string `details`) from a JSON body, when it has one. */
export function serverError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; details?: unknown };
    const parts = [parsed.error, ...(Array.isArray(parsed.details) ? parsed.details : [])].filter(
      (part): part is string => typeof part === 'string' && part.trim() !== '',
    );
    return parts.length ? parts.join('; ') : undefined;
  } catch {
    return undefined;
  }
}

/** The server's sentence: its JSON `error`, or a short plain-text body (no markup or JSON). */
function readable(body: string): string | undefined {
  const text = body.trim();
  return (
    serverError(text) ?? (text && text.length <= 200 && !/[{}<>[\]]/.test(text) ? text : undefined)
  );
}

/** `what` failed: the server's sentence when it sent one, else the status. */
export function requestError(what: string, status: number, body: string): Error {
  const detail = readable(body);
  return new Error(
    detail ? `${what}: ${detail}` : `${what} failed (the server answered ${status}).`,
    { cause: body },
  );
}

const raw = /^(.*?):?\s*HTTP (\d{3}):?\s*([\s\S]*)$/;

/**
 * An error as a page shows it. Messages in the older "<what> HTTP <status>: <body>" form (kept
 * where callers still read them) become plain: the server's sentence, or the status alone.
 */
export function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = raw.exec(message);
  if (!match) return message;
  const [, lead, status, body] = match;
  const detail = readable(body);
  const what = lead.trim() === 'API' ? '' : lead.trim();
  if (detail) return what ? `${what}: ${detail}` : detail;
  return `${what || 'The request'} failed (the server answered ${status}).`;
}
