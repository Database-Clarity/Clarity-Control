/**
 * Client-side "last seen" for My reports: the update time of each report at the last visit. A
 * report whose update time moved on since then gets a dot (in the list and the account menu).
 */
const seenKey = 'clarity-report-seen';
type Row = { id: string; updated_at: number };

function read(): Record<string, number> | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(seenKey) ?? 'null') as unknown;
    return value && typeof value === 'object' ? (value as Record<string, number>) : undefined;
  } catch {
    return undefined;
  }
}

/** Reports updated since the last visit; nothing on the very first visit. */
export function changedSince(rows: Row[]): Set<string> {
  const seen = read();
  if (!seen) return new Set();
  return new Set(rows.filter((row) => (seen[row.id] ?? 0) < row.updated_at).map((row) => row.id));
}

export function markSeen(rows: Row[]): void {
  try {
    localStorage.setItem(
      seenKey,
      JSON.stringify(Object.fromEntries(rows.map((row) => [row.id, row.updated_at]))),
    );
  } catch {
    // The dot is a convenience only.
  }
}
