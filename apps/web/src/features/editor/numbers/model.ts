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
  displayValues: ReadonlyMap<number, string>;
  retired: ReadonlySet<number>;
  byDisplay: ReadonlyMap<string, readonly number[]>;
  byLiteral: ReadonlyMap<string, readonly number[]>;
  longest: number;
  issue?: string;
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
  let map: ReturnType<typeof readNumberMap>;
  try {
    map = readNumberMap({ text, numbers });
  } catch {
    const source: NumberSource = {
      text,
      numbers,
      slots: [],
      byId: new Map(),
      values: new Map(),
      displayValues: new Map(),
      retired: new Set(),
      byDisplay: new Map(),
      byLiteral: new Map(),
      longest: 0,
      issue: 'Save English before inserting its changed numbers.',
    };
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, source);
    return source;
  }
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
    const plain = (part: string) =>
      part.replace(/<[^>]*>|<[^>]*$|^[^<]*>/g, ' ').replace(/\s+/g, ' ');
    const before = plain(line.slice(0, slot.from - lineStart))
      .trim()
      .split(/\s+/)
      .slice(-2)
      .join(' ');
    const after = plain(line.slice(slot.to - lineStart))
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
    const arm = slot.scope.slice(scope?.length ?? 0);
    const inlineScope = [
      ...(arm.includes('pve') ? ['PvE'] : []),
      ...(arm.includes('pvp') ? ['PvP'] : []),
      ...(arm.includes('/base') ? ['Base'] : []),
      ...(arm.includes('/enhanced') ? ['Enhanced'] : []),
    ];
    if (arm.includes('/cell')) {
      const previousLines = text.slice(0, lineStart).split('\n');
      const tableLine = previousLines.reduce(
        (last, line, index) => (/^< table\b/.test(line.trim()) ? index : last),
        -1,
      );
      inlineScope.push(`table row ${slot.line - tableLine}`, `cell ${/\/cell(\d+)/.exec(arm)![1]}`);
    }
    return {
      ...slot,
      id: map.ids[index],
      display: display || slot.value,
      context: `${before} _ ${after}`.trim(),
      breadcrumb: [breadcrumb, ...inlineScope].filter(Boolean).join(' · ') || 'Main text',
      variable: variables.find(
        (variable) =>
          variable.from <= slot.from && !text.slice(variable.from, slot.from).includes('\n'),
      )?.name,
      variables: slot.kind === 'M' ? [...formulaLocals(slot.value, text)] : [],
    };
  });
  const byDisplay = new Map<string, number[]>();
  const duplicateContexts = slots.filter((slot) =>
    slots.some(
      (other) =>
        other !== slot && other.context === slot.context && other.breadcrumb === slot.breadcrumb,
    ),
  );
  for (const slot of duplicateContexts)
    slot.breadcrumb += ` · line ${text.slice(0, slot.from).split('\n').length}`;
  const byLiteral = new Map<string, number[]>();
  for (const slot of slots)
    byDisplay.set(slot.display, [...(byDisplay.get(slot.display) ?? []), slot.id]);
  for (const slot of slots)
    for (const value of new Set([slot.display, slot.kind === 'M' ? slot.display : slot.value]))
      byLiteral.set(value, [...(byLiteral.get(value) ?? []), slot.id]);
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const displayValues = new Map(
    [...values].map(([id, value]) => [
      id,
      byId.get(id)?.display ??
        (value === null
          ? '?'
          : value.startsWith('${')
            ? parseMarkup(value, { variables: '', titles: '', ...globals, lang })
                .lines.flatMap((line) => line.linesContent?.map((part) => part.text ?? '') ?? [])
                .join('')
            : formatNumbers(value, lang)),
    ]),
  );
  const source = {
    text,
    numbers,
    slots,
    byId,
    values,
    displayValues,
    byDisplay,
    byLiteral,
    longest: Math.max(0, ...[...byLiteral.keys()].map((literal) => literal.length)),
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
