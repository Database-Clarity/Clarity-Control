import { resolveAlias } from '../aliases.js';
import { type Lang } from '../languages.js';
import { parseMarkup } from '../markup/parse.js';
import { markupImports, removeUnusedText } from '../markup/prepare.js';
import { isTextlessDescription, tooltipSchema } from '../schemas.js';
import { validateTextWithReads } from '../validation/index.js';
import {
  globalImpactHeaderSchema,
  globalImpactSchema,
  type GlobalImpact,
  type GlobalImpactChange,
  type GlobalImpactRow,
  type GlobalImpactSnapshot,
} from './impactModel.js';
import { globalAggregateHash, globalCauseSchema, validGlobalName } from './model.js';
import { globalSourceLanguage, globalSourceText } from './source.js';

const keyOf = (hash: number, lang: Lang) => `${hash}:${lang}`;

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
    const contexts = Object.values(snapshot.tooltips).map((tooltip) => ({
      tooltip,
      hash: tooltip.hash,
      // Match exportLegacy's exact custom-tooltip fallback, including reserved hash 0.
      type: snapshot.types[tooltip.hash] ?? tooltip.custom?.categoryId,
    }));
    for (const alias of Object.keys(snapshot.aliases)) {
      const canonical = resolveAlias(Number(alias), snapshot.aliases);
      const target = snapshot.tooltips[canonical];
      if (!target || (snapshot.mode === 'live' && isTextlessDescription(target))) continue;
      // A stub copies canonical text, but its own facts can change conditional rendering in
      // legacy outputs. Factless stubs inherit the canonical type. Equal contexts are already
      // covered by the canonical row; retain differing contexts as separate consumer rows.
      const canonicalType = snapshot.types[canonical] ?? target.custom?.categoryId;
      const type = snapshot.types[alias] ?? canonicalType;
      if (type !== canonicalType) contexts.push({ tooltip: target, hash: Number(alias), type });
    }
    const resolvedContexts = new Map<string, NonNullable<GlobalImpactRow['before']>>();
    for (const { tooltip, hash, type } of contexts) {
      if (
        (tooltip.hash >= 1 && tooltip.hash <= 3) ||
        (snapshot.mode === 'live' && isTextlessDescription(tooltip))
      )
        continue;
      if (type === undefined)
        blockers.add(`Missing converter type provenance: ${snapshot.revision}/${tooltip.hash}`);
      for (const language of Object.keys(tooltip.text)) {
        const lang = language as Lang;
        const context = JSON.stringify([tooltip.hash, type, lang]);
        const existing = resolvedContexts.get(context);
        if (existing) {
          result.set(keyOf(hash, lang), { hash, lang, result: existing });
          continue;
        }
        // The converter executes imports even inside hidden exports, where the core parser
        // suppresses unresolved-import diagnostics. Conservatively block that unproven context;
        // do not reconstruct import expansion or symbol resolution here (triage 2).
        const blockHiddenImports = (source: string) => {
          const visible = removeUnusedText(source, false);
          if (markupImports(source).some((line) => !visible.includes(line.trim())))
            blockers.add(
              `Hidden import context requires review: ${snapshot.revision}/${tooltip.hash}/${lang}`,
            );
        };
        const catalog = new Proxy<Record<string, string>>(
          {},
          {
            get(_target, key) {
              if (typeof key !== 'string') return undefined;
              const hash = key === 'global' ? 1 : Number(key);
              if (!Number.isInteger(hash)) return undefined;
              const imported = snapshot.tooltips[resolveAlias(hash, snapshot.aliases)];
              const source =
                imported && !(snapshot.mode === 'live' && isTextlessDescription(imported))
                  ? globalSourceText(imported, lang, snapshot.mode)
                  : undefined;
              if (source !== undefined) blockHiddenImports(source);
              return source;
            },
          },
        );
        const text = globalSourceText(tooltip, lang, snapshot.mode)!;
        blockHiddenImports(text);
        // Match the export's fallback decision, including translations identical to English.
        const numberLanguage = globalSourceLanguage(tooltip, lang, snapshot.mode);
        const globals = {
          variables: catalog[2] ?? '',
          titles: catalog[3] ?? '',
          imports: catalog,
          type,
          lang: numberLanguage,
        };
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
        const rendered = {
          rendered: JSON.stringify(parsed.lines),
          reads: {
            imports: [...validation.reads.imports].map(([key, hash]) => ({ key, hash })),
            variables: [...validation.reads.variables],
            conservativeTitles: true as const,
          },
        };
        resolvedContexts.set(context, rendered);
        result.set(keyOf(hash, lang), {
          hash,
          lang,
          result: rendered,
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
  const aggregate = snapshot.tooltips[globalAggregateHash(change.kind)];
  const source = aggregate ? globalSourceLanguage(aggregate, lang, snapshot.mode) : lang;
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
          cell.result.reads.imports.some((read) => read.hash === globalAggregateHash(change.kind))
        ) {
          affected = true;
          reason = 'aggregate-import';
        } else if (change.kind === 'titles') {
          affected = true;
          reason = 'title-preparation';
        } else if (
          change.kind === 'variables' &&
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
