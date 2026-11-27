import {
  extractBlocks,
  findElementTags,
  lowerConsumerMarkup,
  parseMarkup,
  resolveNumberTokens,
  type MarkupGlobals,
} from '@clarity/core';
import { formatNumbers } from '@clarity/core/markup/numberFormat';
import { markupConditions } from '../../../../../packages/core/src/markup/prepare';
import { descriptionConverter } from '../../../../../packages/export/src/converter/descriptionConverter';
import type {
  ExpandedPerks,
  IntermediatePerk,
  PerkTypes,
} from '../../../../../packages/export/src/converter/types';

export type TagOracleRefusal = 'tag-output' | 'tag-unresolved' | 'tag-invisible' | 'tag-unclosed';

/**
 * An unclosed maths block (`${` with no `}` after it on its line) or comment (`/*` with no later
 * `*\/`) can join text across what the tooltip shows, so tagging refuses while one is open in the
 * tooltip or anything it imports. Closed blocks never block.
 */
function hasUnclosedBlock(text: string) {
  for (const raw of text.split('\n')) {
    // A braced reference's `}` closes the reference, not the maths block around it.
    const line = raw.replace(/#\{(?:[a-zA-Z0-9]+|=[1-9]\d*)\}/g, '#');
    const open = line.lastIndexOf('${');
    if (open >= 0 && !line.includes('}', open + 2)) return true;
  }
  const comment = text.lastIndexOf('/*');
  return comment >= 0 && !text.includes('*/', comment + 2);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Change = { from: number; to: number; insert: string };
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const equal = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: Json | undefined): value is ObjectValue =>
  value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
const plainText = (value: Json | undefined): value is { text: string } =>
  object(value) && Object.keys(value).length === 1 && typeof value.text === 'string';

/** An inserted icon splits a text run. Rejoin adjacent plain spans for the comparison. */
function joinText(value: Json): Json {
  if (Array.isArray(value)) {
    const joined: Json[] = [];
    for (const member of value.map(joinText)) {
      const last = joined.at(-1);
      if (plainText(member) && plainText(last)) last.text += member.text;
      else joined.push(member);
    }
    return joined;
  }
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, joinText(member)]),
    );
  return value;
}

class OutputChanged extends Error {}

/**
 * Rendering the same edit with a different element identifies its exact output spans, even
 * when the tooltip already uses the same icon or words. Remove only the identified addition.
 */
function stripNewTag(
  actual: Json,
  control: Json,
  element: string,
  alternate: string,
  selected: readonly string[],
  absorbed: boolean,
) {
  let placements = 0;
  const icon = { classNames: [element] };
  const controlIcon = { classNames: [alternate] };
  const withoutAddition = (a: Json, b: Json): Json => {
    if (equal(a, b)) return a;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      const output: Json[] = [];
      for (let i = 0; i < a.length; i++) {
        if (!equal(a[i], icon) || !equal(b[i], controlIcon)) {
          output.push(withoutAddition(a[i], b[i]));
          continue;
        }
        const span = a[i + 1];
        const other = b[i + 1];
        if (
          !object(span) ||
          !object(other) ||
          typeof span.text !== 'string' ||
          span.text !== other.text
        )
          throw new OutputChanged();
        const tinted =
          equal(span.classNames, ['elementText', element]) &&
          equal(other.classNames, ['elementText', alternate]);
        if (
          tinted
            ? !selected.includes(span.text.trim())
            : !plainText(span) || !selected.some((text) => span.text.trimStart().startsWith(text))
        )
          throw new OutputChanged();
        placements++;
        if (absorbed) output.push(a[i]);
        if (tinted) {
          output.push({ text: span.text });
          i++;
        }
      }
      return output;
    }
    if (object(a) && object(b) && equal(Object.keys(a), Object.keys(b))) {
      return Object.fromEntries(
        Object.entries(a).map(([key, member]) => [key, withoutAddition(member, b[key])]),
      );
    }
    throw new OutputChanged();
  };
  const output = joinText(withoutAddition(actual, control));
  return { output, placements };
}

// The probe record cannot collide with a 32-bit manifest hash.
const probeHash = 4294967296;

/** The converter reads the same language, lowered source, and imports as the export input. */
function legacyRender(source: string, globals: MarkupGlobals): Json {
  const language = globals.lang ?? globals.numberInput?.lang ?? 'en';
  const type = (globals.type ?? 'none') as PerkTypes;
  const resolved = resolveNumberTokens(source, globals.numberInput?.values ?? new Map());
  const importText = (key: string) =>
    key === String(probeHash)
      ? resolved
      : key === '2'
        ? globals.variables
        : key === '3'
          ? globals.titles
          : key === '1'
            ? (globals.imports?.global ?? globals.imports?.['1'] ?? '')
            : globals.imports?.[key];
  const database = new Proxy(Object.create(null) as ExpandedPerks, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      const authored = importText(key);
      if (authored === undefined) return undefined;
      const text = lowerConsumerMarkup(authored);
      const perk: IntermediatePerk = {
        hash: Number(key),
        type,
        name: '',
        uploadedBy: '',
        updateTracker: { descriptions: {} },
        lastUpload: 0,
        inLiveDatabase: false,
        uploadToLive: false,
        editor: { [language]: { main: text, secondary: text } },
      };
      return perk;
    },
  });
  return json(
    descriptionConverter({
      descriptionString: lowerConsumerMarkup(resolved),
      editorType: 'main',
      hash: probeHash,
      language,
      database,
    }) ?? [],
  );
}

function previewRender(source: string, globals: MarkupGlobals): Json {
  const parsed = parseMarkup(source, { ...globals, onVariable: undefined });
  if (parsed.diagnostics.some(({ severity }) => severity === 'error'))
    throw new Error('The preview could not be evaluated');
  return json(parsed);
}

/** The oracle is invoked only on acceptance. The two renderers are also the consumer paths. */
/** The tooltip, the shared globals, and every document it imports (followed by reference). */
export function unclosedBlockRefusal(source: string, globals: MarkupGlobals): boolean {
  const seen = new Set<string>();
  const pending = [source, globals.variables, globals.titles];
  for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
    if (hasUnclosedBlock(text)) return true;
    for (const match of text.matchAll(/^import .+ from (\d+|global)\b/gm)) {
      const key = match[1]!;
      if (seen.has(key)) continue;
      seen.add(key);
      const imported =
        globals.imports?.[key] ?? (key === 'global' ? globals.imports?.['1'] : undefined);
      if (imported !== undefined) pending.push(imported);
    }
  }
  return false;
}

export function tagInsertionRefusal(
  before: string,
  change: Change,
  globals: MarkupGlobals,
  expected = before,
): TagOracleRefusal | null {
  if (unclosedBlockRefusal(before, globals)) return 'tag-unclosed';
  const tag = findElementTags(change.insert)[0];
  if (!tag) return 'tag-invisible';
  const alternate = tag.element === 'solar' ? 'arc' : 'solar';
  const replace = (insert: string) =>
    before.slice(0, change.from) + insert + before.slice(change.to);
  const after = replace(change.insert);
  const control = replace(`<${alternate} ${tag.text} />`);
  const withoutSelection = replace('');
  const absorbed = before.slice(change.from, change.to).startsWith(`<${tag.element}/>`);
  const types = new Set([globals.type, undefined, ...markupConditions.map(([, type]) => type)]);
  const selected = [
    tag.text.trim(),
    formatNumbers(tag.text, globals.lang ?? globals.numberInput?.lang).trim(),
  ];
  // An authored title can be checked through the normal title renderer before it is used.
  const titles = Object.keys(extractBlocks(before, 'title'));
  const titleReferences = titles.map((name) => `<title Title [${name}] />`).join('\n');
  let placed = false;
  try {
    for (const type of types) {
      const scope = { ...globals, type };
      for (const append of ['', ...(titleReferences ? [`\n${titleReferences}`] : [])]) {
        for (const render of [previewRender, legacyRender]) {
          const unchanged = render(expected + append, scope);
          const actual = render(after + append, scope);
          // An absorbed icon that leaves the output identical (a table row icon) is safe as is.
          if (absorbed && equal(actual, unchanged)) {
            placed = true;
            continue;
          }
          const original = joinText(unchanged);
          const alternative = render(control + append, scope);
          const result = stripNewTag(
            actual,
            alternative,
            tag.element,
            alternate,
            selected,
            absorbed,
          );
          if (!equal(result.output, original)) return 'tag-output';
          if (
            !result.placements &&
            !equal(joinText(render(withoutSelection + append, scope)), original)
          )
            return 'tag-invisible';
          placed ||= result.placements > 0;
        }
      }
    }
  } catch (error) {
    return error instanceof OutputChanged ? 'tag-output' : 'tag-unresolved';
  }
  return placed ? null : 'tag-invisible';
}
