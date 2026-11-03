/** Recently inserted suggestions, kept on this device only; the menu lists them first. */

const key = 'clarity-suggest-recent:v1';
const limit = 16;

let cache: string[] | undefined;

function read(): string[] {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? '[]');
    cache = Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string').slice(0, limit)
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** Most recent first. */
export function recentSuggestions(): readonly string[] {
  return read();
}

export function rememberSuggestion(id: string): void {
  const next = [id, ...read().filter((existing) => existing !== id)].slice(0, limit);
  cache = next;
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(next));
  } catch {
    // Private mode or a full quota: the list still works for this visit.
  }
}

/** Test hook: forget the in-memory copy so the next read goes to storage. */
export function resetRecentCache(): void {
  cache = undefined;
}
