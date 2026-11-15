import {
  formatNumbers,
  formulaLocals,
  numberBlockOpen,
  numberSlots,
  numberValues,
  numberVariables,
  parseMarkup,
  readNumberMap,
  type Lang,
  type MarkupGlobals,
  type MarkupLine,
  type NumberMap,
  type NumberSlot,
} from '@clarity/core';

export interface EditorNumber extends NumberSlot {
  id: number;
  display: string;
  context: string;
  breadcrumb: string;
  variables: readonly string[];
  variable?: string;
}
export interface NumberSource {
  text: string;
  numbers?: NumberMap;
  slots: readonly EditorNumber[];
  byId: ReadonlyMap<number, EditorNumber>;
  values: ReadonlyMap<number, string | null>;
  retired: ReadonlySet<number>;
  byDisplay: ReadonlyMap<string, readonly number[]>;
  longest: number;
}

const cache = new Map<string, NumberSource>();
const importVersions = new WeakMap<object, number>();
let importVersion = 0;
export function numberSource(
  text: string,
  numbers: NumberMap | undefined,
  lang: Lang,
  globals?: MarkupGlobals,
): NumberSource {
  if (globals?.imports && !importVersions.has(globals.imports))
    importVersions.set(globals.imports, ++importVersion);
  const key = JSON.stringify([
    text,
    numbers,
    lang,
    globals?.type,
    globals?.variables,
    globals?.titles,
    text.includes('import ') && globals?.imports ? importVersions.get(globals.imports) : undefined,
  ]);
  const previous = cache.get(key);
  if (previous) return previous;
  const map = readNumberMap({ text, numbers });
  const values = numberValues({ text, numbers }, lang);
  const variables = numberVariables(text);
  const detected = numberSlots(text);
  const rendered = new Map<number, string>();
  if (detected.some((slot) => slot.kind === 'M')) {
    const collect = (lines: MarkupLine[]) => {
      for (const line of lines)
        for (const part of [
          ...(line.linesContent ?? []),
          ...(line.table?.flatMap(
            (row) => row.rowContent?.flatMap((cell) => cell.cellContent) ?? [],
          ) ?? []),
        ]) {
          for (const slot of part.slots ?? [])
            rendered.set(slot.id, part.text!.slice(slot.from, slot.to));
          if (part.title) collect(part.title);
        }
    };
    collect(
      parseMarkup(text, { variables: '', titles: '', ...globals, lang }, { slots: map.ids }).lines,
    );
  }
  const slots = detected.map((slot, index): EditorNumber => {
    const lineStart = text.lastIndexOf('\n', slot.from - 1) + 1;
    const lineEnd = text.indexOf('\n', slot.to);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    const before = line
      .slice(0, slot.from - lineStart)
      .trim()
      .split(/\s+/)
      .slice(-2)
      .join(' ');
    const after = line
      .slice(slot.to - lineStart)
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(' ');
    const display =
      slot.kind === 'M'
        ? (rendered.get(map.ids[index]) ??
          parseMarkup(slot.value, { variables: text, titles: '', ...globals, lang })
            .lines.flatMap((line) => line.linesContent?.map((part) => part.text ?? '') ?? [])
            .join(''))
        : formatNumbers(slot.value, lang);
    const scope = /^\[.*\]/.exec(slot.scope)?.[0];
    const breadcrumb = scope
      ? (JSON.parse(scope) as string[])
          .filter(Boolean)
          .map((part) => part.replace(/\s*\($/, '').replace(/:$/, ''))
          .join(' · ')
      : '';
    return {
      ...slot,
      id: map.ids[index],
      display: display || slot.value,
      context: `${before} _ ${after}`.trim(),
      breadcrumb: breadcrumb || 'Main text',
      variable: variables.find(
        (variable) =>
          variable.from <= slot.from && !text.slice(variable.from, slot.from).includes('\n'),
      )?.name,
      variables: slot.kind === 'M' ? [...formulaLocals(slot.value, text)] : [],
    };
  });
  const byDisplay = new Map<string, number[]>();
  for (const slot of slots)
    byDisplay.set(slot.display, [...(byDisplay.get(slot.display) ?? []), slot.id]);
  const source = {
    text,
    numbers,
    slots,
    byId: new Map(slots.map((slot) => [slot.id, slot])),
    values,
    byDisplay,
    longest: Math.max(0, ...slots.map((slot) => slot.display.length)),
    retired: new Set(Object.keys(map.retired).map(Number)),
  };
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, source);
  sourceDeclarations(source);
  return source;
}

export function tokenizedEnglish(source: NumberSource): string {
  let text = '',
    at = 0;
  for (const slot of source.slots) {
    text += source.text.slice(at, slot.from) + `#{=${slot.id}}`;
    at = slot.to;
  }
  return text + source.text.slice(at);
}

export interface StructureLine {
  from: number;
  to: number;
  text: string;
}
/** Only structural lines are retained; commands never rescan the editor document. */
export const isStructureLine = (text: string) =>
  numberBlockOpen.test(text.trim()) || /^\s*\)\s*$/.test(text) || /^var \w+ = /.test(text);

export function scopedLines(lines: readonly StructureLine[]) {
  const stack: string[] = [];
  return lines.map((line) => {
    const scope = stack.join('\n');
    if (numberBlockOpen.test(line.text.trim())) stack.push(line.text.trim());
    else if (/^\s*\)\s*$/.test(line.text)) stack.pop();
    return { ...line, scope };
  });
}

const declarations = new WeakMap<NumberSource, ReturnType<typeof computeDeclarations>>();
export function sourceDeclarations(source: NumberSource) {
  let found = declarations.get(source);
  if (!found) declarations.set(source, (found = computeDeclarations(source)));
  return found;
}
function computeDeclarations(source: NumberSource) {
  const lines: StructureLine[] = [];
  let from = 0;
  for (const text of source.text.split('\n')) {
    if (isStructureLine(text)) lines.push({ from, to: from + text.length, text });
    from += text.length + 1;
  }
  const scoped = scopedLines(lines);
  return numberVariables(source.text).map((variable) => {
    const line = scoped.find((line) => line.from <= variable.from && line.to >= variable.from)!;
    const slots = source.slots.filter((slot) => slot.from >= variable.from && slot.to <= line.to);
    let text = '',
      at = line.from;
    for (const slot of slots) {
      text += source.text.slice(at, slot.from) + `#{=${slot.id}}`;
      at = slot.to;
    }
    text += source.text.slice(at, line.to);
    const close = scoped.find(
      (entry) => entry.from > line.from && entry.scope === line.scope && /^\s*\)/.test(entry.text),
    );
    const following = source.slots
      .filter((slot) => slot.from > (close?.to ?? line.to))
      .map((slot) => slot.id);
    return { name: variable.name, scope: line.scope, text, from: line.from, following };
  });
}
