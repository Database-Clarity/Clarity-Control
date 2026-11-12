// Seeded random file configs for G-PREVIEW (spec section 9): the same seeds give the same files in
// the Node test and in the browser check, so the worker's bytes can be compared with build-site's.
import { newStyleFile, styles, type Style } from '@clarity/export';
import {
  exportLanguages,
  itemKeys,
  symbolIds,
  type StyleFile,
  type SymbolRule,
} from '@clarity/export/config';

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tokens = ['', '*', '**', '[', ']', '(', ')', '_', '<b>', '</b>', ':arc:', '🡅', '>'];

/** A valid style file from `seed`, choosing among `categories` (the pinned catalog's ids). */
export function randomFile(seed: number, categories: readonly string[]): StyleFile {
  const random = mulberry32(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const some = <T>(list: readonly T[], chance: number) => list.filter(() => random() < chance);
  const style = pick(styles) as Style;
  const shape = random() < 0.5 ? 'lines' : 'text';
  const chosen = some(categories, 0.5);
  const languages = some(exportLanguages, 0.3);
  const file = newStyleFile(
    `random-${seed}`,
    style,
    {
      categories: chosen,
      sandboxPerks: some(chosen, 0.5),
      frameAliases: random() < 0.5,
      languages: languages.length ? languages : ['en'],
      keys: some(itemKeys, 0.5),
      bungieIdentical: random() < 0.3,
    },
    shape,
  );
  const rule = (): SymbolRule | undefined => {
    const roll = random();
    if (roll < 0.1) return undefined;
    if (roll < 0.4 && shape === 'lines') return { mode: 'keep' };
    if (roll < 0.6) return { mode: 'drop' };
    return { mode: 'replace', before: pick(tokens), after: pick(tokens) };
  };
  for (const symbol of symbolIds) {
    const next = rule();
    if (next) file.format.symbols[symbol] = next;
    else delete file.format.symbols[symbol];
  }
  const roll = random();
  file.format.titles =
    roll < 0.3 && shape === 'lines'
      ? { mode: 'keep' }
      : roll < 0.6
        ? { mode: 'drop' }
        : { mode: 'inline', pattern: [pick(tokens), pick(tokens), pick(tokens), pick(tokens)] };
  const links = random();
  file.format.links =
    links < 0.3 && shape === 'lines'
      ? { mode: 'keep' }
      : links < 0.6
        ? { mode: 'drop' }
        : { mode: 'replace', pattern: ['[', ']', '(', ')'] };
  file.format.spacer = random() < 0.5 ? 'keep' : 'drop';
  return file;
}

export const randomFiles = (count: number, categories: readonly string[]) =>
  Array.from({ length: count }, (_, index) => randomFile(1000 + index, categories));
