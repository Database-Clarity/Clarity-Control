import {
  numberValues,
  resolveNumberTokens,
  usesEnglishFallback,
  resolveAlias,
  type Aliases,
  type Lang,
  type MarkupGlobals,
  type Tooltip,
} from '@clarity/core';
import type { Drafts } from './draftStorage';

type NumberInput = NonNullable<MarkupGlobals['numberInput']>;
const numberInputs = new Map<string, Omit<NumberInput, 'fallback'>>();
const numberedImports = new WeakMap<object, (hash: string) => boolean>();
const numberGlobals = new WeakMap<MarkupGlobals, WeakMap<Tooltip, Map<Lang, MarkupGlobals>>>();

/** One cached English map per source revision and language, never detected on a typing key. */
export function previewNumberGlobals(
  tooltip: Tooltip | undefined,
  lang: Lang,
  globals: MarkupGlobals,
): MarkupGlobals {
  if (lang === 'en' || !tooltip?.text.en) return globals;
  const english = tooltip.text.en;
  const key = JSON.stringify([english.text, english.numbers, lang]);
  let input = numberInputs.get(key);
  if (!input) {
    if (numberInputs.size >= 64) numberInputs.delete(numberInputs.keys().next().value!);
    let values: ReturnType<typeof numberValues>, issue: string | undefined;
    try {
      values = numberValues(english, lang);
    } catch {
      values = new Map();
      issue = 'Save English before translating its changed numbers.';
    }
    input = { values, english: english.text, lang, ...(issue && { issue }) };
    numberInputs.set(key, input);
  }
  let byTooltip = numberGlobals.get(globals);
  if (!byTooltip) numberGlobals.set(globals, (byTooltip = new WeakMap()));
  let byLanguage = byTooltip.get(tooltip);
  if (!byLanguage) byTooltip.set(tooltip, (byLanguage = new Map()));
  let result = byLanguage.get(lang);
  if (!result) {
    result = {
      ...globals,
      numberInput: {
        ...input,
        // Only the deferred parser reads this; constructing editor globals never scans a draft.
        get fallback() {
          return usesEnglishFallback(tooltip, lang);
        },
        hasImportedNumbers: (hash) =>
          !!globals.imports && !!numberedImports.get(globals.imports)?.(hash),
      },
    };
    byLanguage.set(lang, result);
  }
  return result;
}

function resolvedImport(tooltip: Tooltip, lang: Lang, text: string): string {
  if (lang === 'en' || !text.includes('#{=')) return text;
  if (usesEnglishFallback(tooltip, lang)) return tooltip.text.en?.text ?? '?';
  try {
    return resolveNumberTokens(
      text,
      tooltip.text.en ? numberValuesCached(tooltip, lang) : new Map(),
    );
  } catch {
    return '?';
  }
}
function numberValuesCached(tooltip: Tooltip, lang: Lang) {
  return previewNumberGlobals(tooltip, lang, emptyNumberGlobals).numberInput!.values;
}
const emptyNumberGlobals: MarkupGlobals = { variables: '', titles: '' };

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
    const tooltipAt = (key: string) => {
      const hash = Number(key);
      if (!Number.isInteger(hash) || String(hash) !== key) return undefined;
      const canonical = resolveAlias(hash, aliases);
      return drafts[canonical]?.next ?? tooltips[canonical];
    };
    const read = (key: string) => {
      const tooltip = tooltipAt(key);
      return tooltip ? resolvedImport(tooltip, lang, tooltip.text[lang]?.text ?? '') : undefined;
    };
    const proxy = new Proxy<Record<string, string>>(
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
    numberedImports.set(
      proxy,
      (key) => lang !== 'en' && !!tooltipAt(key)?.text[lang]?.text.includes('#{='),
    );
    return proxy;
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
  const tooltipAt = (key: string) => {
    const hash = Number(key);
    if (!Number.isInteger(hash) || String(hash) !== key) return undefined;
    const canonical = saved.aliases.get(key) ?? hash;
    return drafts[canonical]?.next ?? tooltips[canonical];
  };
  const read = (key: string) => {
    const hash = Number(key);
    if (!Number.isInteger(hash) || String(hash) !== key) return undefined;
    const canonical = saved.aliases.get(key) ?? hash;
    const raw =
      drafts[canonical]?.next.text[lang]?.text ?? (drafts[canonical] ? '' : text[canonical]);
    return raw === undefined || lang === 'en' || !raw.includes('#{=')
      ? raw
      : resolvedImport(tooltipAt(key)!, lang, raw);
  };
  const proxy = new Proxy<Record<string, string>>(
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
  numberedImports.set(
    proxy,
    (key) => lang !== 'en' && !!tooltipAt(key)?.text[lang]?.text.includes('#{='),
  );
  return proxy;
}

/** Shared variables, titles, and the import catalogue of one language, drafts over saved text. */
export function importGlobals(
  data: { bundle: { tooltips: Record<string, Tooltip> }; aliases: Aliases } | null,
  source: Drafts,
  lang: Lang,
): MarkupGlobals {
  const imports = tooltipImports(data?.bundle.tooltips ?? {}, source, lang, data?.aliases ?? {});
  return { variables: imports[2] ?? '', titles: imports[3] ?? '', imports };
}
