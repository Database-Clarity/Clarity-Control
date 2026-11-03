import type { Tooltip } from '@clarity/core';

/**
 * How often a markup pattern appears across the English tooltips. Counted on demand for the one
 * option the detail pane shows, from saved text only (drafts would make it change as you type),
 * and cached for as long as the same tooltip set is loaded.
 */
export interface UsageCorpus {
  /** Number of tooltips whose English text matches; undefined while there is nothing to count. */
  count(pattern: RegExp): number;
  readonly size: number;
}

export function corpusUsage(tooltips: Readonly<Record<string, Tooltip>>): UsageCorpus {
  let texts: string[] | undefined;
  const cache = new Map<string, number>();
  const all = () =>
    (texts ??= Object.values(tooltips).flatMap((tooltip) => {
      const text = tooltip.text.en?.text;
      return text ? [text] : [];
    }));
  return {
    get size() {
      return all().length;
    },
    count(pattern) {
      const id = `${pattern.source}/${pattern.flags}`;
      let value = cache.get(id);
      if (value === undefined) {
        // Never global: `test` on a /g pattern would carry lastIndex between tooltips.
        const plain = new RegExp(pattern.source, pattern.flags.replace('g', ''));
        value = all().filter((text) => plain.test(text)).length;
        cache.set(id, value);
      }
      return value;
    },
  };
}
