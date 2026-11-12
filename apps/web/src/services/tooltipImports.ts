import { resolveAlias, type Aliases, type Lang, type Tooltip } from '@clarity/core';
import type { Drafts } from './draftStorage';

// Saved text and alias membership are immutable for a loaded catalogue. Index them once,
// rather than resolving every saved hash again whenever one draft gains a character.
const savedImports = new WeakMap<
  Record<string, Tooltip>,
  WeakMap<
    Aliases,
    Map<Lang, { text: Record<string, string>; aliases: ReadonlyMap<string, number> }>
  >
>();
const aliasIndexes = new WeakMap<Aliases, ReadonlyMap<string, number>>();
function aliasIndex(aliases: Aliases) {
  let index = aliasIndexes.get(aliases);
  if (!index) {
    index = new Map(
      Object.keys(aliases).map((hash) => [hash, resolveAlias(Number(hash), aliases)]),
    );
    aliasIndexes.set(aliases, index);
  }
  return index;
}

export function tooltipImports(
  tooltips: Record<string, Tooltip>,
  drafts: Drafts,
  lang: Lang,
  aliases: Aliases,
  options?: { lookupOnly?: boolean },
): Record<string, string> {
  // Render-only consumers resolve individual documents, never a suggestion
  // catalogue. Keep their first lookup independent of catalogue size.
  if (options?.lookupOnly) {
    const read = (key: string) => {
      const hash = Number(key);
      if (!Number.isInteger(hash) || String(hash) !== key) return undefined;
      const canonical = resolveAlias(hash, aliases);
      const tooltip = drafts[canonical]?.next ?? tooltips[canonical];
      return tooltip ? (tooltip.text[lang]?.text ?? '') : undefined;
    };
    return new Proxy<Record<string, string>>(
      {},
      {
        get: (_target, key) => (typeof key === 'string' ? read(key) : undefined),
        has: (_target, key) => typeof key === 'string' && read(key) !== undefined,
        getOwnPropertyDescriptor(_target, key) {
          const value = typeof key === 'string' ? read(key) : undefined;
          return value === undefined ? undefined : { configurable: true, enumerable: true, value };
        },
      },
    );
  }
  let byAliases = savedImports.get(tooltips);
  if (!byAliases) savedImports.set(tooltips, (byAliases = new WeakMap()));
  let byLanguage = byAliases.get(aliases);
  if (!byLanguage) byAliases.set(aliases, (byLanguage = new Map()));
  let saved = byLanguage.get(lang);
  if (!saved) {
    const index = aliasIndex(aliases);
    const text: Record<string, string> = {};
    for (const [hash, tooltip] of Object.entries(tooltips)) {
      if ((index.get(hash) ?? Number(hash)) === Number(hash)) {
        text[hash] = tooltip.text[lang]?.text ?? '';
      }
    }
    saved = {
      text,
      aliases: index,
    };
    byLanguage.set(lang, saved);
  }
  // Consumers normally read one imported document. Keep the snapshot lazy so typing
  // does not copy thousands of strings just to look up the two global documents.
  // Enumeration (the explicit suggestion menu) still exposes the complete same record.
  const text = saved.text;
  const read = (key: string) => {
    const hash = Number(key);
    if (!Number.isInteger(hash) || String(hash) !== key) return undefined;
    const canonical = saved.aliases.get(key) ?? hash;
    return drafts[canonical]?.next.text[lang]?.text ?? (drafts[canonical] ? '' : text[canonical]);
  };
  return new Proxy<Record<string, string>>(
    {},
    {
      get(_target, key) {
        return typeof key === 'string' ? read(key) : undefined;
      },
      ownKeys() {
        const keys = { ...text };
        for (const hash of Object.keys(drafts)) {
          if ((saved.aliases.get(hash) ?? Number(hash)) === Number(hash)) keys[hash] = '';
        }
        for (const [hash, canonical] of saved.aliases) {
          if (read(String(canonical)) !== undefined) keys[hash] = '';
        }
        return Object.keys(keys);
      },
      getOwnPropertyDescriptor(_target, key) {
        const value = typeof key === 'string' ? read(key) : undefined;
        return value === undefined ? undefined : { configurable: true, enumerable: true, value };
      },
      has(_target, key) {
        return typeof key === 'string' && read(key) !== undefined;
      },
    },
  );
}
