import type { CompendiumCell } from '@clarity/core';

/** The review fingerprint's exact canonical JSON, normalized once per repeated cell. */
export function matchingSessionFingerprint(value: unknown) {
  const cells = new Map<string, { runs: CompendiumCell['runs']; value: unknown }>();
  const styles = new Map<string, string>();
  function normalizedCell(cell: CompendiumCell): CompendiumCell {
    const runs: CompendiumCell['runs'] = [];
    let previousStyle: string | undefined;
    for (const run of cell.runs) {
      if (!run.text) continue;
      const entries = Object.entries(run).filter(([key]) => key !== 'text' && key !== 'textAlign');
      const signature = JSON.stringify(entries);
      let style = styles.get(signature);
      if (style === undefined) {
        style = JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
        styles.set(signature, style);
      }
      // Match evidenceCell's adjacent-run normalization. Cache style comparison
      // across the sheet instead of sorting both neighboring styles per run.
      const last = runs.at(-1);
      if (last && style === previousStyle) last.text += run.text;
      else {
        const copy = { ...run };
        delete copy.textAlign;
        runs.push(copy);
      }
      previousStyle = style;
    }
    return { plain: runs.map((run) => run.text).join(''), runs };
  }
  function canonical(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonical);
    if ('plain' in value && 'runs' in value) {
      const cell = value as CompendiumCell;
      const key = JSON.stringify(cell.runs);
      const cached = cells.get(key);
      // JSON omits undefined style properties, while evidenceCell's strict
      // adjacent-style comparison still distinguishes them from absent keys.
      if (
        cached &&
        cached.runs.every((run, index) => {
          const keys = Object.keys(run);
          const other = cell.runs[index];
          return (
            keys.length === Object.keys(other).length &&
            keys.every((key) => Object.hasOwn(other, key))
          );
        })
      )
        return cached.value;
      const normalized = sorted(normalizedCell(cell));
      cells.set(key, { runs: cell.runs, value: normalized });
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
