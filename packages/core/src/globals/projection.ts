import { type Lang } from '../languages.js';
import { stableStringify } from '../contentHash.js';
import { markupCommentContext, removeMarkupComments } from '../markup/prepare.js';
import { extractBlocks, extractVariables } from '../markup/syntax.js';
import { tooltipSchema, type Tooltip } from '../schemas.js';
import {
  globalRevisionSchema,
  globalStoreSchema,
  validGlobalName,
  type GlobalRecord,
  type GlobalSegment,
  type GlobalStore,
} from './model.js';

interface Declaration {
  name: string;
  body: string;
  from: number;
  to: number;
  beforeName: string;
  afterName: string;
  afterBody: string;
}

/** Inventory only the resolver's declaration grammar; refuse ambiguous legacy material. */
function declarations(raw: string, kind: GlobalRecord['kind']): Declaration[] {
  const offsets: number[] = [];
  let text = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\r') {
      offsets.push(i);
      text += raw[i];
    }
  }
  const boundary = (index: number) => (index === text.length ? raw.length : offsets[index]);
  const pattern =
    kind === 'variables' ? /^var ([a-zA-Z0-9]+) = (.+)$/gm : /^title ([A-z0-9 ]+) \(\n[^]*?\n\)$/gm;
  const found: Declaration[] = [];
  const comments = markupCommentContext(raw).comments;
  let last = 0;
  const names = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (!validGlobalName(kind, name) || names.has(name))
      throw new Error(`Duplicate or unrepresentable ${kind} declaration: ${name}`);
    names.add(name);
    const from = boundary(match.index),
      to = boundary(match.index + match[0].length);
    if (
      removeMarkupComments(raw.slice(last, from)).trim() ||
      comments.some((comment) => from >= comment.from && from < comment.to)
    )
      throw new Error('Aggregate needs manual mapping: prose or commented declaration');
    const nameFrom = from + (kind === 'variables' ? 4 : 6);
    const nameTo = nameFrom + name.length;
    let bodyFrom: number, bodyTo: number;
    if (kind === 'variables') {
      const value = match[2];
      bodyFrom = boundary(match.index + 7 + name.length + value.length - value.trimStart().length);
      bodyTo = boundary(match.index + 7 + name.length + value.trimEnd().length);
    } else {
      bodyFrom = boundary(match.index + match[0].indexOf('\n') + 1);
      bodyTo = boundary(match.index + match[0].length - 2);
    }
    if (raw[bodyTo - 1] === '\r' && raw[bodyTo] === '\n') bodyTo--;
    const body = raw.slice(bodyFrom, bodyTo);
    found.push({
      name,
      body: kind === 'variables' && body === 'empty' ? '' : body,
      from,
      to,
      beforeName: raw.slice(from, nameFrom),
      afterName: raw.slice(nameTo, bodyFrom),
      afterBody: raw.slice(bodyTo, to),
    });
    last = to;
  }
  if (removeMarkupComments(raw.slice(last)).trim())
    throw new Error('Aggregate needs manual mapping: unparsed source');
  return found;
}

export interface GlobalInventorySource {
  repository: string;
  revision: string;
  /** Actual repository file and decoded JSON field, supplied by the reader, never inferred. */
  locate(hash: 2 | 3, lang: Lang): { path: string; selector: string[] };
}

/** Pure dry run. The caller supplies fresh opaque IDs; this function never reads or writes files. */
export function inventoryGlobals(
  aggregates: readonly Tooltip[],
  source: GlobalInventorySource,
  allocateId: () => string,
): GlobalStore {
  if (!source.repository.trim()) throw new Error('Missing repository provenance');
  globalRevisionSchema.parse(source.revision);
  const entries: GlobalRecord[] = [];
  const layouts: GlobalStore['aggregates'] = [];
  for (const input of aggregates) {
    const { text, ...document } = tooltipSchema.parse(input);
    if (document.hash !== 2 && document.hash !== 3) throw new Error('Expected aggregate 2 or 3');
    const kind = document.hash === 2 ? 'variables' : 'titles';
    const layout: GlobalStore['aggregates'][number] = { document, languages: {} };
    for (const [language, cell] of Object.entries(text)) {
      const lang = language as Lang;
      const { text: raw, ...metadata } = cell;
      const segments: GlobalSegment[] = [];
      let last = 0;
      for (const declaration of declarations(raw, kind)) {
        let entry = entries.find((v) => v.kind === kind && v.name === declaration.name);
        if (!entry) {
          entry = {
            version: 1,
            id: allocateId(),
            kind,
            name: declaration.name,
            revision: source.revision,
            definitions: {},
            nameHistory: [],
          };
          entries.push(entry);
        }
        entry.definitions[lang] = {
          body: declaration.body,
          ...metadata,
          revision: source.revision,
          provenance: {
            repository: source.repository,
            revision: source.revision,
            ...source.locate(document.hash, lang),
            spanConvention: 'decoded-utf16',
            hash: document.hash,
            lang,
            from: declaration.from,
            to: declaration.to,
          },
        };
        segments.push({ literal: raw.slice(last, declaration.from) });
        segments.push({
          entryId: entry.id,
          beforeName: declaration.beforeName,
          afterName: declaration.afterName,
          afterBody: declaration.afterBody,
        });
        last = declaration.to;
      }
      segments.push({ literal: raw.slice(last) });
      layout.languages[lang] = { metadata, segments };
    }
    layouts.push(layout);
  }
  const store = globalStoreSchema.parse({ version: 1, entries, aggregates: layouts });
  const projected = projectGlobals(store);
  for (const input of aggregates) {
    const output = projected[String(input.hash)];
    if (stableStringify(output.text) !== stableStringify(input.text))
      throw new Error(`Aggregate ${input.hash} did not round-trip exactly`);
  }
  return store;
}

/** The ordered, read-only hash 2/3 compatibility view. Missing recipes/provenance fail closed. */
export function projectGlobals(input: GlobalStore): Record<string, Tooltip> {
  const store = globalStoreSchema.parse(input);
  const entries = new Map(store.entries.map((entry) => [entry.id, entry]));
  const result: Record<string, Tooltip> = {};
  for (const aggregate of store.aggregates) {
    const text: Tooltip['text'] = {};
    const kind = aggregate.document.hash === 2 ? 'variables' : 'titles';
    for (const [language, layout] of Object.entries(aggregate.languages)) {
      const lang = language as Lang;
      const expected: { name: string; body: string }[] = [];
      const raw = layout.segments
        .map((segment) => {
          if ('literal' in segment) return segment.literal;
          const entry = entries.get(segment.entryId)!;
          const definition = entry.definitions[lang]!;
          expected.push({ name: entry.name, body: definition.body });
          const body = kind === 'variables' && definition.body === '' ? 'empty' : definition.body;
          return segment.beforeName + entry.name + segment.afterName + body + segment.afterBody;
        })
        .join('');
      const parsed = declarations(raw, kind);
      if (
        JSON.stringify(parsed.map(({ name, body }) => ({ name, body }))) !==
        JSON.stringify(expected)
      )
        throw new Error('Projection recipe changed declaration identity or body');
      const resolved =
        kind === 'variables'
          ? extractVariables(raw.replace(/\r/g, ''))
          : extractBlocks(raw.replace(/\r/g, ''), 'title');
      for (const { name, body } of expected) {
        if (resolved[name] !== body.replace(/\r/g, ''))
          throw new Error(`Projection changes resolver semantics for ${name}`);
      }
      text[lang] = { ...layout.metadata, text: raw };
    }
    result[aggregate.document.hash] = tooltipSchema.parse({ ...aggregate.document, text });
  }
  return result;
}
