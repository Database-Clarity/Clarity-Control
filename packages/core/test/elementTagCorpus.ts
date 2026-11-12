import { findElementTags, lowerElementTags } from '../src/markup/elementTags.js';
import type { Tooltip } from '../src/schemas.js';

/**
 * Tagged test inputs for the exporters (ELEMENT-TAGS-2 AC1). `raiseElementPairs` turns every
 * existing pair in real text, an element icon immediately followed by a word (`<solar/>Scorch`),
 * into element-tagged text (`<solar Scorch />`), keeping only raises whose lowered form is the
 * original text exactly. An exporter that lowers must then write byte for byte what it writes for
 * the original text, which is the hand-written lowered form.
 */
const pair = /<(kinetic|arc|solar|void|stasis|strand)\/>(\p{L}[\p{L}'’-]*)/gu;

export function raiseElementPairs(text: string): { text: string; raised: number } {
  if (!text.includes('/>')) return { text, raised: 0 };
  const raised = text.replace(pair, '<$1 $2 />');
  if (raised === text || lowerElementTags(raised) !== text) return { text, raised: 0 };
  return { text: raised, raised: findElementTags(raised).length };
}

/** Hand-written fixtures: tagged text and its lowered (today's) form, written out by hand. */
export const loweredFixtures: [name: string, tagged: string, lowered: string][] = [
  ['plain wrap', 'Gain <solar Scorch /> stacks.', 'Gain <solar/>Scorch stacks.'],
  [
    'multi-word text',
    'Creates a <void Void Breach /> on kill.',
    'Creates a <void/>Void Breach on kill.',
  ],
  [
    'every element',
    '<kinetic Kinetic />, <arc Jolt />, <solar Scorch />, <void Volatile />, <stasis Slow />, <strand Sever />',
    '<kinetic/>Kinetic, <arc/>Jolt, <solar/>Scorch, <void/>Volatile, <stasis/>Slow, <strand/>Sever',
  ],
  ['pve line', '<pve/>Applies <arc Jolt /> to targets.', '<pve/>Applies <arc/>Jolt to targets.'],
  ['pvp line', '<pvp/><stasis Slow /> for 2s', '<pvp/><stasis/>Slow for 2s'],
  ['yellow line', '<yellow/>Grants <strand Woven Mail />.', '<yellow/>Grants <strand/>Woven Mail.'],
  [
    'title body',
    'title Info (\nApplies <stasis Slow /> stacks.\n)\nSee <title details [Info] />.',
    'title Info (\nApplies <stasis/>Slow stacks.\n)\nSee <title details [Info] />.',
  ],
  [
    'export block',
    'export Main (\nSuspends with <strand Suspend />.\n)\nGain <arc Amplified />.',
    'export Main (\nSuspends with <strand/>Suspend.\n)\nGain <arc/>Amplified.',
  ],
  [
    'enhanced section',
    'Base text.\nenhanced (\n🡅 Longer <solar Radiant /> duration.\n)',
    'Base text.\nenhanced (\n🡅 Longer <solar/>Radiant duration.\n)',
  ],
  [
    'table cell',
    '< table wide >\n| <arc Amplified /> | 10%\n<$>',
    '< table wide >\n| <arc/>Amplified | 10%\n<$>',
  ],
  ['adjacent standalone icon', 'Gain <solar/><solar Scorch />.', 'Gain <solar/><solar/>Scorch.'],
  ['spaced text', 'Gain <solar  Scorch  /> stacks.', 'Gain <solar/> Scorch  stacks.'],
  [
    'unicode',
    'Verursacht <arc Blitz – Überladung 雷 /> Schaden.',
    'Verursacht <arc/>Blitz – Überladung 雷 Schaden.',
  ],
  // Part 1's icon-only cases: the preview draws these untinted; the export lowers them all the same.
  [
    'icon-only: variable',
    'var X = 5\nGain <solar #X Scorch />.',
    'var X = 5\nGain <solar/>#X Scorch.',
  ],
  ['icon-only: math', 'Gain <arc ${2*3} Jolt />.', 'Gain <arc/>${2*3} Jolt.'],
  ['icon-only: comment', 'Gain <void Volatile /* note */ />.', 'Gain <void/>Volatile /* note */.'],
];

/** Every language of every tooltip with its element pairs raised into tags; the count raised. */
export function raiseTooltips(tooltips: readonly Tooltip[]): {
  tooltips: Tooltip[];
  raised: number;
} {
  let raised = 0;
  const result = tooltips.map((source) => {
    const text = Object.fromEntries(
      Object.entries(source.text).map(([lang, entry]) => {
        const up = raiseElementPairs(entry!.text);
        raised += up.raised;
        return [lang, { ...entry!, text: up.text }];
      }),
    );
    return { ...source, text };
  });
  return { tooltips: result, raised };
}
