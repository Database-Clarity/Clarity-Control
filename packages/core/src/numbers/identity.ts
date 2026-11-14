import { diffArrays } from 'diff';
import {
  numberProse,
  numberSlots,
  numberTemplate,
  type NumberSlot,
} from '../markup/numberSlots.js';

interface Unit {
  text: string;
  slot?: number;
  line: number;
}
export interface SlotAlignment {
  kind: 'same' | 'value' | 'text';
  before: NumberSlot[];
  after: NumberSlot[];
  /** Old slot index -> new slot index, never values or ids. */
  map: Map<number, number>;
  changed: number[];
  steps: Map<number, 'value' | 'line' | 'moved' | 'word'>;
}

function units(text: string, slots: NumberSlot[]): Unit[][] {
  const lines: Unit[][] = [[]];
  let at = 0;
  const push = (part: string) => {
    for (const match of part.matchAll(/\n|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)) {
      if (match[0] === '\n') lines.push([]);
      else lines.at(-1)!.push({ text: match[0], line: lines.length - 1 });
    }
  };
  slots.forEach((slot, index) => {
    push(text.slice(at, slot.from));
    lines.at(-1)!.push({ text: '\u001f' + slot.kind, slot: index, line: lines.length - 1 });
    at = slot.to;
  });
  push(text.slice(at));
  return lines;
}

function matches(a: string[], b: string[]): [number, number][] {
  const pairs: [number, number][] = [];
  let old = 0,
    next = 0;
  for (const part of diffArrays(a, b)) {
    if (!part.added && !part.removed)
      for (let i = 0; i < part.value.length; i++) pairs.push([old + i, next + i]);
    if (!part.added) old += part.value.length;
    if (!part.removed) next += part.value.length;
  }
  return pairs;
}
const counts = (values: string[]) => {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
};
const slotUnit = (unit: Unit | undefined) => unit?.slot !== undefined;
function window(units: Unit[], index: number, width: number): string {
  const line = units[index].line;
  return JSON.stringify(
    units
      .slice(Math.max(0, index - width), index + width + 1)
      .filter((unit) => unit.line === line)
      .map((unit) => unit.text.toLowerCase()),
  );
}

/** Conservative identity: equal templates, unique lines, then uniquely anchored word windows. */
export function alignSlots(before: string, after: string): SlotAlignment {
  const old = numberSlots(before),
    next = numberSlots(after);
  const result: SlotAlignment = {
    kind: 'text',
    before: old,
    after: next,
    map: new Map(),
    changed: [],
    steps: new Map(),
  };
  const keep = (a: number, b: number, step: 'value' | 'line' | 'moved' | 'word') => {
    result.map.set(a, b);
    result.steps.set(a, step);
    if (old[a].value !== next[b].value) result.changed.push(a);
  };
  if (numberTemplate(before, old) === numberTemplate(after, next)) {
    old.forEach((_, index) => keep(index, index, 'value'));
    result.kind = result.changed.length ? 'value' : 'same';
    return result;
  }
  const oldLines = units(numberProse(before), old),
    nextLines = units(numberProse(after), next);
  const keys = (lines: Unit[][]) =>
    lines.map((line) => JSON.stringify(line.map((unit) => unit.text)));
  const aKeys = keys(oldLines),
    bKeys = keys(nextLines);
  const aCounts = counts(aKeys),
    bCounts = counts(bKeys);
  const usedA = new Set<number>(),
    usedB = new Set<number>();
  const unique = (a: number, b: number) =>
    aCounts.get(aKeys[a]) === 1 &&
    bCounts.get(bKeys[b]) === 1 &&
    (bCounts.get(aKeys[a]) ?? 0) <= 1 &&
    (aCounts.get(bKeys[b]) ?? 0) <= 1;
  const pairLine = (a: number, b: number, step: 'line' | 'moved') => {
    if (!unique(a, b)) return;
    const pairs = oldLines[a].flatMap((unit, i) =>
      unit.slot === undefined ? [] : [[unit.slot, nextLines[b][i].slot!] as const],
    );
    if (pairs.some(([x, y]) => old[x].scope !== next[y].scope)) return;
    usedA.add(a);
    usedB.add(b);
    for (const [x, y] of pairs) keep(x, y, step);
  };
  for (const [a, b] of matches(aKeys, bKeys)) pairLine(a, b, 'line');
  const nextByKey = new Map(bKeys.map((key, index) => [key, index]));
  for (let a = 0; a < oldLines.length; a++) {
    if (usedA.has(a) || !oldLines[a].some((unit) => !slotUnit(unit) && /\p{L}/u.test(unit.text)))
      continue;
    const b = nextByKey.get(aKeys[a]);
    if (b !== undefined && !usedB.has(b)) pairLine(a, b, 'moved');
  }
  const remaining = (lines: Unit[][], used: Set<number>) =>
    lines.flatMap((line, i) =>
      used.has(i) ? [] : [{ text: '\n', line: -1 }, ...line, { text: '\n', line: -1 }],
    );
  const a = remaining(oldLines, usedA),
    b = remaining(nextLines, usedB);
  const signatures = (list: Unit[]) =>
    counts(list.flatMap((unit, i) => (slotUnit(unit) ? [window(list, i, 3)] : [])));
  const aSigs = signatures(a),
    bSigs = signatures(b);
  const pairs = matches(
    a.map((unit) => unit.text),
    b.map((unit) => unit.text),
  );
  const paired = new Map(pairs);
  for (const [i, j] of pairs) {
    const x = a[i].slot,
      y = b[j].slot;
    if (x === undefined || y === undefined || !unique(a[i].line, b[j].line)) continue;
    if (
      paired.get(i - 1) !== j - 1 ||
      paired.get(i + 1) !== j + 1 ||
      slotUnit(a[i - 1]) ||
      slotUnit(a[i + 1])
    )
      continue;
    if (old[x].scope !== next[y].scope || window(a, i, 2) !== window(b, j, 2)) continue;
    if (aSigs.get(window(a, i, 3)) !== 1 || bSigs.get(window(b, j, 3)) !== 1) continue;
    keep(x, y, 'word');
  }
  return result;
}
