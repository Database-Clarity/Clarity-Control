import { evidenceCell, type CompendiumCell } from '@clarity/core';

/** The review fingerprint's exact canonical JSON, normalized once per repeated cell. */
export function matchingSessionFingerprint(value: unknown) {
  const cells = new Map<string, unknown>();
  function canonical(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonical);
    if ('plain' in value && 'runs' in value) {
      const key = JSON.stringify(value.runs);
      if (cells.has(key)) return cells.get(key);
      const normalized = sorted(evidenceCell(value as CompendiumCell));
      cells.set(key, normalized);
      return normalized;
    }
    return sorted(value);
  }
  function sorted(value: object): unknown {
    // Ordinary objects retain V8's JSON serialization fast path. Preserve the
    // canonicalizer's data-key semantics even for a literal __proto__ property.
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = canonical((value as Record<string, unknown>)[key]);
      if (key === '__proto__')
        Object.defineProperty(result, key, { value: entry, enumerable: true });
      else result[key] = entry;
    }
    return result;
  }
  const text = JSON.stringify(canonical(value));
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}
