import { exportLanguages, iconSymbols, itemKeys, symbolIds } from '../../v1/vocabulary.js';

const iconDescription: Record<string, string> = {
  kinetic: 'Kinetic damage',
  arc: 'Arc damage',
  solar: 'Solar damage',
  stasis: 'Stasis damage',
  void: 'Void damage',
  strand: 'Strand damage',
  prismatic: 'Prismatic',
  heavy: 'Heavy ammo',
  primary: 'Primary ammo',
  special: 'Special ammo',
  barrier: 'Barrier champion',
  overload: 'Overload champion',
  unstoppable: 'Unstoppable champion',
  hunter: 'Hunter',
  titan: 'Titan',
  warlock: 'Warlock',
};
export type Feature = {
  id: string;
  anchor: string;
  description: string;
  example: unknown;
  fallback: string;
};
const feature = (id: string, description: string, example: unknown, fallback: string): Feature => ({
  id,
  anchor: '#part-' + id,
  description,
  example,
  fallback,
});
export const features: Feature[] = [
  feature(
    'text',
    'Plain text, including bullets. No HTML is interpreted.',
    { text: '• Bullets are text.' },
    '• Bullets are text.',
  ),
  ...(['bold', 'exotic', 'pve', 'pvp'] as const).map((style) =>
    feature(
      'style-' + style,
      `${style} on a part or a whole line.`,
      { text: style === 'pvp' ? '[15%]' : '30%', style: [style] },
      style === 'pvp' ? '[15%]' : '30%',
    ),
  ),
  feature(
    'line-style',
    'A style applies to the whole line.',
    { style: ['bold'], parts: [{ text: 'A bold line.' }] },
    'A bold line.',
  ),
  feature(
    'icon',
    'The 16 game symbols. Use the accessible name when artwork is unavailable.',
    { parts: iconSymbols.flatMap((icon) => [{ icon }, { text: icon + ' ' }]) },
    iconSymbols.map((icon) => '[' + icon + ']').join(' '),
  ),
  feature('icon-arrow', 'A value changes into another value.', { icon: 'arrow' }, '→'),
  feature(
    'icon-enhanced-arrow',
    'An enhanced value. The text keeps its original glyph.',
    { icon: 'enhancedArrow', text: '🡅' },
    '🡅',
  ),
  feature(
    'element',
    'Element text carries a tint; its icon is a separate preceding part.',
    { text: 'Scorch', element: 'solar' },
    'Scorch',
  ),
  feature(
    'link',
    'A labelled web address. Reject unsafe URL schemes.',
    { text: 'Clarity', link: 'https://d2clarity.com' },
    'Clarity (https://d2clarity.com)',
  ),
  feature(
    'note',
    'Extra lines for a word. Nested notes are written inline.',
    { text: 'refills', note: [{ parts: [{ text: 'Refills the magazine from reserves.' }] }] },
    'refills (Refills the magazine from reserves.)',
  ),
  feature('spacer', 'A gap between lines.', { spacer: true }, '\n'),
];
// Explicit documentation coverage: adding a vocabulary symbol without documenting it fails.
const documentedSymbols: Record<string, string> = {
  ...Object.fromEntries(Object.keys(iconDescription).map((id) => [id, '#part-icon'])),
  arrow: '#part-icon-arrow',
  enhancedArrow: '#part-icon-enhanced-arrow',
  bold: '#part-style-bold',
  exotic: '#part-style-exotic',
  pve: '#part-style-pve',
  pvp: '#part-style-pvp',
  elementText: '#part-element',
};
export function featureTable(symbols: readonly string[] = symbolIds) {
  for (const symbol of symbols)
    if (!documentedSymbols[symbol]) throw new Error('Undocumented symbol: ' + symbol);
  return {
    format: 1,
    parts: features,
    symbols: symbols.map((id) => ({
      id,
      anchor: documentedSymbols[id],
      description: iconDescription[id] || id,
      example:
        id === 'elementText'
          ? { text: 'Scorch', element: 'solar' }
          : iconDescription[id] || id === 'arrow' || id === 'enhancedArrow'
            ? { icon: id, ...(id === 'enhancedArrow' ? { text: '🡅' } : {}) }
            : { text: '30%', style: [id] },
      fallback:
        id === 'elementText'
          ? 'Scorch'
          : id === 'arrow'
            ? '→'
            : id === 'enhancedArrow'
              ? '🡅'
              : iconDescription[id]
                ? '[' + id + ']'
                : '30%',
    })),
    keys: [
      ...[
        'format',
        'shape',
        'languages',
        'descriptions',
        'perks',
        'description',
        ...itemKeys.filter((key) => key !== 'editedBy'),
      ].map((key) => [key, '#file']),
      ...['edited.<lang>.at', 'edited.<lang>.by'].map((key) => [key, '#file']),
      ...['parts', 'spacer', 'style'].map((key) => [key, '#lines']),
      ...['text', 'icon', 'element', 'link', 'note'].map((key) => [key, '#parts']),
      ...[
        'project',
        'id',
        'path',
        'sha256',
        'bytes',
        'updatedAt',
        'status',
        'updatesUntil',
        'files',
        'notices',
      ].map((key) => [key, '#updates']),
    ].map(([id, anchor]) => ({
      id,
      anchor,
      example: keyExamples[id],
      fallback: JSON.stringify(keyExamples[id]),
    })),
    values: Object.fromEntries(
      Object.entries({
        styles: ['bold', 'exotic', 'pve', 'pvp'],
        elements: ['kinetic', 'arc', 'solar', 'void', 'stasis', 'strand', 'prismatic'],
        languages: exportLanguages,
        shape: ['lines', 'text'],
        status: ['current', 'stale', 'frozen'],
      }).map(([group, values]) => [
        group,
        values.map((value) => ({
          value,
          anchor:
            group === 'styles'
              ? '#part-style-' + value
              : group === 'elements'
                ? '#part-element'
                : group === 'languages'
                  ? '#languages'
                  : group === 'status'
                    ? '#updates'
                    : '#file',
          example:
            group === 'styles'
              ? { text: '30%', style: [value] }
              : group === 'elements'
                ? { text: 'Scorch', element: value }
                : value,
          fallback: group === 'styles' ? '30%' : group === 'elements' ? 'Scorch' : value,
        })),
      ]),
    ),
  };
}

const keyExamples: Record<string, unknown> = {
  format: 1,
  shape: 'lines',
  languages: ['en'],
  descriptions: [{ en: [{ parts: [{ text: 'Research.' }] }] }],
  perks: { '1001': { name: 'Example perk', description: 0 } },
  description: 0,
  name: 'Example perk',
  itemHash: 1001,
  itemName: 'Example item',
  category: 'weapon-trait',
  edited: { en: { at: '2026-11-18T00:00:00.000Z', by: 'Clarity' } },
  references: [1002],
  'edited.<lang>.at': '2026-11-18T00:00:00.000Z',
  'edited.<lang>.by': 'Clarity',
  parts: [{ text: 'Research.' }],
  spacer: true,
  style: ['bold'],
  text: 'Research.',
  icon: 'solar',
  element: 'solar',
  link: 'https://d2clarity.com',
  note: [{ parts: [{ text: 'A note.' }] }],
  project: 'reference',
  id: 'lines',
  path: 'reference/v1/lines/en.json',
  sha256: '0'.repeat(64),
  bytes: 1234,
  updatedAt: '2026-11-18T00:00:00.000Z',
  status: 'current',
  updatesUntil: '2027-02-18T00:00:00.000Z',
  files: [],
  notices: [],
};

export function formatSchema() {
  const ref = (name: string) => ({ $ref: '#/$defs/' + name });
  const string = { type: 'string' };
  const languageMap = (value: unknown) => ({
    type: 'object',
    properties: Object.fromEntries(exportLanguages.map((lang) => [lang, value])),
    additionalProperties: false,
    minProperties: 1,
  });
  const file = (shape: string) => ({
    type: 'object',
    required: ['format', 'shape', 'languages', 'descriptions', 'perks'],
    properties: {
      format: { const: 1 },
      shape: { const: shape },
      languages: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { enum: exportLanguages },
      },
      descriptions: { type: 'array', items: languageMap(shape === 'text' ? string : ref('lines')) },
      perks: { type: 'object', additionalProperties: ref('perk') },
    },
  });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://data.d2clarity.com/reference/format-v1.schema.json',
    title: 'Clarity format v1 file or project index',
    oneOf: [file('lines'), file('text'), ref('index')],
    $defs: {
      style: {
        type: 'array',
        uniqueItems: true,
        items: { enum: ['bold', 'exotic', 'pve', 'pvp'] },
      },
      lines: { type: 'array', items: ref('line') },
      line: {
        oneOf: [
          {
            type: 'object',
            required: ['spacer'],
            properties: { spacer: { const: true } },
            not: { required: ['parts'] },
          },
          {
            type: 'object',
            required: ['parts'],
            properties: { parts: { type: 'array', items: ref('part') }, style: ref('style') },
            not: { required: ['spacer'] },
          },
        ],
      },
      part: {
        type: 'object',
        anyOf: [{ required: ['text'] }, { required: ['icon'] }],
        properties: {
          text: string,
          icon: { enum: [...iconSymbols, 'arrow', 'enhancedArrow'] },
          style: ref('style'),
          element: { enum: ['kinetic', 'arc', 'solar', 'void', 'stasis', 'strand', 'prismatic'] },
          link: string,
          note: ref('lines'),
        },
      },
      perk: {
        type: 'object',
        required: ['description'],
        properties: {
          description: { type: 'integer', minimum: 0 },
          name: string,
          itemHash: { type: 'integer' },
          itemName: string,
          category: string,
          edited: languageMap({
            type: 'object',
            properties: { at: { type: 'string', format: 'date-time' }, by: string },
          }),
          references: { type: 'array', items: { type: 'integer' }, uniqueItems: true },
        },
      },
      index: {
        type: 'object',
        required: ['project', 'name', 'files', 'notices'],
        properties: {
          project: string,
          name: string,
          notices: { type: 'array', items: { type: 'object' } },
          files: {
            type: 'array',
            items: {
              type: 'object',
              required: [
                'id',
                'format',
                'path',
                'languages',
                'sha256',
                'bytes',
                'updatedAt',
                'status',
              ],
              properties: {
                id: string,
                format: { type: 'integer', minimum: 1 },
                path: string,
                languages: { type: 'array', items: { enum: exportLanguages } },
                sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                bytes: { type: 'integer', minimum: 0 },
                updatedAt: { type: 'string', format: 'date-time' },
                status: { enum: ['current', 'stale', 'frozen'] },
                updatesUntil: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
    },
  };
}
