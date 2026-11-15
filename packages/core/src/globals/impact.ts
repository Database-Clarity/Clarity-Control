import { resolveAlias } from '../aliases.js';
import { usesEnglishFallback } from '../exportLegacy.js';
import { type Lang } from '../languages.js';
import { parseMarkup } from '../markup/parse.js';
import { lowerConsumerMarkup } from '../markup/braces.js';
import { numberValues, resolveNumberTokens } from '../numbers/map.js';
import { isTextlessDescription, tooltipSchema, type Tooltip } from '../schemas.js';
import { validateTextWithReads } from '../validation/index.js';
import {
  globalImpactHeaderSchema,
  globalImpactSchema,
  type GlobalImpact,
  type GlobalImpactChange,
  type GlobalImpactRow,
  type GlobalImpactSnapshot,
} from './impactModel.js';
import { globalCauseSchema, validGlobalName } from './model.js';

const keyOf = (hash: number, lang: Lang) => `${hash}:${lang}`;
function sourceLanguage(snapshot: GlobalImpactSnapshot, tooltip: Tooltip, lang: Lang): Lang {
  return snapshot.mode === 'live' && usesEnglishFallback(tooltip, lang) ? 'en' : lang;
}
function textOf(snapshot: GlobalImpactSnapshot, tooltip: Tooltip, lang: Lang): string | undefined {
  // Missing languages are omitted by exportLegacy, never synthesized from English.
  if (!tooltip.text[lang]) return undefined;
  const source = tooltip.text[sourceLanguage(snapshot, tooltip, lang)]!;
  if (snapshot.mode === 'authored') return source.text;
  const resolved =
    source.text.includes('#{=') && tooltip.text.en
      ? resolveNumberTokens(source.text, numberValues(tooltip.text.en, lang))
      : source.text;
  return lowerConsumerMarkup(resolved);
}

interface Resolved {
  hash: number;
  lang: Lang;
  result: NonNullable<GlobalImpactRow['before']>;
}

/**
 * Resolve complete snapshots, rather than reverse-scanning regex references. Validation reads
 * include actual nested/missing/aliased import accesses and conservative title preparation.
 * The flat read set does not claim source-path attribution that markup does not yet expose.
 */
function resolveSnapshot(
  snapshot: GlobalImpactSnapshot,
  blockers: Set<string>,
): Map<string, Resolved> {
  const result = new Map<string, Resolved>();
  try {
    const { tooltips: _tooltips, ...header } = snapshot;
    void _tooltips;
    globalImpactHeaderSchema.parse(header);
    for (const [key, tooltip] of Object.entries(snapshot.tooltips)) {
      tooltipSchema.parse(tooltip);
      if (key !== String(tooltip.hash)) throw new Error(`Catalogue key/hash mismatch: ${key}`);
      if (resolveAlias(tooltip.hash, snapshot.aliases) !== tooltip.hash)
        throw new Error(`Alias ${key} has its own tooltip`);
    }
    for (const alias of Object.keys(snapshot.aliases))
      resolveAlias(Number(alias), snapshot.aliases);
    for (const tooltip of Object.values(snapshot.tooltips)) {
      if (
        (tooltip.hash >= 1 && tooltip.hash <= 3) ||
        (snapshot.mode === 'live' && isTextlessDescription(tooltip))
      )
        continue;
      if (!Object.hasOwn(snapshot.types, String(tooltip.hash)))
        blockers.add(`Missing converter type provenance: ${snapshot.revision}/${tooltip.hash}`);
      for (const language of Object.keys(tooltip.text)) {
        const lang = language as Lang;
        const catalog = new Proxy<Record<string, string>>(
          {},
          {
            get(_target, key) {
              if (typeof key !== 'string') return undefined;
              const hash = key === 'global' ? 1 : Number(key);
              if (!Number.isInteger(hash)) return undefined;
              const imported = snapshot.tooltips[resolveAlias(hash, snapshot.aliases)];
              return imported && !(snapshot.mode === 'live' && isTextlessDescription(imported))
                ? textOf(snapshot, imported, lang)
                : undefined;
            },
          },
        );
        const globals = {
          variables: catalog[2] ?? '',
          titles: catalog[3] ?? '',
          imports: catalog,
          type: snapshot.types[tooltip.hash],
          lang,
        };
        const text = textOf(snapshot, tooltip, lang)!;
        const validation = validateTextWithReads(
          text,
          lang,
          globals,
          false,
          tooltip.hash,
          snapshot.aliases,
        );
        const parsed = parseMarkup(text, globals);
        // Cycles/depth limits cannot establish a complete closure; malformed live number slots,
        // unresolved imports, and other resolver errors also require repair before publication.
        for (const issue of parsed.diagnostics) {
          if (issue.severity === 'error')
            blockers.add(`${snapshot.revision}/${tooltip.hash}/${lang}: ${issue.message}`);
        }
        result.set(keyOf(tooltip.hash, lang), {
          hash: tooltip.hash,
          lang,
          result: {
            rendered: JSON.stringify(parsed.lines),
            reads: {
              imports: [...validation.reads.imports].map(([key, hash]) => ({ key, hash })),
              variables: [...validation.reads.variables],
              conservativeTitles: true,
            },
          },
        });
      }
    }
  } catch (error) {
    blockers.add(
      `Unproven snapshot ${snapshot.revision}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result;
}

function languageAffected(
  snapshot: GlobalImpactSnapshot,
  change: GlobalImpactChange,
  lang: Lang,
): boolean {
  if (!change.languages) return true;
  // English revisions also change the source meaning that translated consumers must review.
  if (change.languages.includes('en')) return true;
  const aggregate = snapshot.tooltips[change.kind === 'variables' ? 2 : 3];
  const source = aggregate ? sourceLanguage(snapshot, aggregate, lang) : lang;
  return change.languages.includes(source);
}

/** Union both sides, retaining deleted cells/consumers and every cause, including no-output changes. */
export function calculateGlobalImpact(
  before: GlobalImpactSnapshot,
  after: GlobalImpactSnapshot,
  changes: readonly GlobalImpactChange[],
  destination: string,
): GlobalImpact {
  for (const change of changes) {
    globalCauseSchema.parse(change.cause);
    for (const name of [change.beforeName, change.afterName])
      if (name !== undefined && !validGlobalName(change.kind, name))
        throw new Error('Invalid changed global name');
    if (!change.beforeName && !change.afterName) throw new Error('Missing changed global identity');
  }
  const blockers = new Set<string>();
  if (before.repository !== after.repository || before.mode !== after.mode)
    blockers.add('Before/after snapshots must describe the same repository and resolution mode');
  const old = resolveSnapshot(before, blockers),
    next = resolveSnapshot(after, blockers);
  const rows: GlobalImpactRow[] = [];
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(key),
      b = next.get(key),
      { hash, lang } = (a ?? b)!;
    const causes: GlobalImpactRow['causes'] = [];
    let reason: GlobalImpactRow['reason'] = 'variable-read';
    for (const change of changes) {
      let affected = false;
      for (const [snapshot, cell] of [
        [before, a],
        [after, b],
      ] as const) {
        if (!cell || !languageAffected(snapshot, change, lang)) continue;
        if (
          cell.result.reads.imports.some(
            (read) => read.hash === (change.kind === 'variables' ? 2 : 3),
          )
        ) {
          affected = true;
          reason = 'aggregate-import';
        } else if (change.kind === 'titles') {
          affected = true;
          reason = 'title-preparation';
        } else if (
          cell.result.reads.variables.some(
            (name) => name === change.beforeName || name === change.afterName,
          )
        ) {
          affected = true;
        }
      }
      if (affected || blockers.size) causes.push(change.cause);
    }
    if (causes.length)
      rows.push({
        consumer: { hash, lang, destination },
        causes,
        reason: blockers.size ? 'unproven' : reason,
        before: a?.result ?? null,
        after: b?.result ?? null,
      });
  }
  return globalImpactSchema.parse({
    version: 1,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    complete: blockers.size === 0,
    blockers: [...blockers],
    rows,
  });
}
