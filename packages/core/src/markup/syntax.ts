export const markupColors = ['blue', 'green', 'purple', 'yellow', 'center', 'bold', 'pve', 'pvp'];
export const markupIcons = [
  'kinetic',
  'arc',
  'solar',
  'stasis',
  'void',
  'strand',
  'heavy',
  'primary',
  'special',
  'barrier',
  'overload',
  'unstoppable',
  'hunter',
  'titan',
  'warlock',
];
export const markupEmpty = ['background', 'breakSpaces', 'bold'];
export const markupLineClasses = [...markupColors, ...markupEmpty];
/**
 * Retired markup (owner 2026-11-09): the parser still reads these, so old text renders as before,
 * but no editor surface offers them and the validator flags them (validation/retired.ts).
 */
export const markupRetiredColors = ['blue', 'green', 'purple'];
export const markupRetiredLineStyles = ['center', 'breakSpaces', 'background'];
export const markupRetired = [...markupRetiredColors, ...markupRetiredLineStyles];
export const markupTableClasses = [
  'background_1',
  'background_2',
  'centerTable',
  'formula',
  'wide',
];
export function extractVariables(text: string): Record<string, string> {
  return Object.fromEntries(
    [...text.matchAll(/^var ([a-zA-Z0-9]+) = (.+)$/gm)].map((match) => [
      match[1],
      match[2].trim() === 'empty' ? '' : match[2].trim(),
    ]),
  );
}

export function extractBlocks(text: string, kind: 'title' | 'export'): Record<string, string> {
  const pattern =
    kind === 'title' ? /^title [A-z0-9 ]+ \([^]*?\n\)$/gm : /^export [A-z0-9 ]+ \([\s\S]*?\n\)$/gm;
  return Object.fromEntries(
    [...text.matchAll(pattern)].map(([block]) => {
      const lines = block.split('\n');
      const name = lines[0]
        .replace(kind === 'title' ? /title|\(.*/gi : /export|hidden|\(.*/gi, '')
        .trim();
      return [name, lines.slice(1, -1).join('\n')];
    }),
  );
}
import type { Lang } from '../languages.js';

export function markupLanguage(lang: Lang): string {
  return lang === 'zh-chs' ? 'zh-Hans' : lang === 'zh-cht' ? 'zh-Hant' : lang;
}
