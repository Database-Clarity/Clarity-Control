// @vitest-environment jsdom
import { beforeAll, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ComponentType } from 'react';
import { parseMarkup, type MarkupLine } from '@clarity/core';
import { showcaseGlobals, showcaseText } from '@clarity/core/markup/showcase';
import { compile, exportLanguages, symbolIds } from '../../src/index.js';
import { configSchema } from '../../src/config.js';
import { referenceProject } from '../../src/site/reference/project.js';
import { rendererSource } from '../../src/site/reference/renderer.js';
import { features, featureTable } from '../../src/site/reference/features.js';
import { referenceSite } from '../../src/site/reference/site.js';

// Evaluate the exact downloadable module in the browser realm, retaining its public API.
const source = rendererSource.replace(/export (const|function) /g, '$1 ');
const renderer = new Function(
  source + '\nreturn {decode,details,renderDom,renderDetails,renderText};',
)();
const input = JSON.parse(readFileSync('packages/export/test/fixtures/legacy-input.json', 'utf8'));
const file = referenceProject.files[0];
const plan = compile(input, file, { catalog: { items: {}, categories: [] } });
const lines = plan.expanded!['-1'].descriptions.en!;

test('reference is reserved for partners; the fixed project compiles both shapes and every language', () => {
  expect(configSchema.safeParse(referenceProject).success).toBe(false);
  for (const file of referenceProject.files) {
    const result = compile(input, file, { catalog: { items: {}, categories: [] } });
    expect(result.outputs).toHaveLength(exportLanguages.length);
    expect(result.outputs!.every((output) => '-1' in output.file.perks)).toBe(true);
    expect(result.outputs![0].file.shape).toBe(file.id);
  }
});

test('the generated feature table covers vocabulary and rejects a new undocumented symbol', () => {
  expect(featureTable().symbols.map((symbol) => symbol.id)).toEqual([...symbolIds]);
  expect(() => featureTable([...symbolIds, 'undocumented'])).toThrow('Undocumented symbol');
});

test('details reuse a reading-order number for repeated note bodies and link addresses', () => {
  const note = [{ parts: [{ text: 'From reserves.' }] }];
  const input = [
    {
      parts: [
        { text: 'refills', note },
        { text: 'Wiki', link: 'https://example.com' },
        { text: 'refills again', note },
        { text: 'Same page', link: 'https://example.com' },
      ],
    },
  ];
  expect(renderer.details(input).map((d: { n: number; kind: string }) => [d.n, d.kind])).toEqual([
    [1, 'note'],
    [2, 'link'],
  ]);
  const output = renderer.renderDom(input, { notes: 'numbered', interactive: false });
  expect(
    [...output.querySelectorAll('sup')].map((element) => (element as Element).textContent),
  ).toEqual(['[1]', '[2]', '[1]', '[2]']);
  expect(output.querySelector('a,button,[tabindex]')).toBeNull();
  expect(
    renderer.renderDetails(input, { interactive: false }).querySelector('a,button,[tabindex]'),
  ).toBeNull();
});

test('untrusted data stays text, unsafe links never navigate, and unknown values retain fallback text', () => {
  const content = [
    {
      parts: [
        { text: '<img src=x onerror=alert(1)>', style: ['unknown'], element: 'unknown' },
        { text: 'fallback', icon: 'unknown' },
        { text: 'bad', link: 'javascript:alert(1)' },
      ],
    },
  ];
  const output = renderer.renderDom(content);
  expect(output.querySelector('img,a,script')).toBeNull();
  expect(output.textContent).toBe('<img src=x onerror=alert(1)>fallbackbad');
  expect(renderer.renderText(content)).toContain('Unsafe link omitted');
});

test('nested notes render inline, strings pass through, and icon overrides work', () => {
  const nested = [
    {
      parts: [
        {
          text: 'Outer',
          note: [{ parts: [{ text: 'Inner', note: [{ parts: [{ text: 'Body' }] }] }] }],
        },
      ],
    },
  ];
  const output = renderer.renderDom(nested, { notes: 'expand' });
  expect(output.querySelectorAll('button')).toHaveLength(1);
  expect(output.textContent).toBe('OuterInner (Body)');
  output.querySelector('button').click();
  expect(output.querySelector('button').getAttribute('aria-expanded')).toBe('true');
  expect(renderer.renderText('plain <text>')).toBe('plain <text>');
  expect(renderer.renderDom('plain <text>').textContent).toBe('plain <text>');
  const override = renderer.renderDom([{ parts: [{ icon: 'solar' }] }], {
    icon: () => document.createElement('svg'),
  });
  expect(override.querySelector('svg')).not.toBeNull();
  expect(override.querySelector('img')).toBeNull();
});

let preview: ComponentType<{ lines: MarkupLine[] }>;
beforeAll(async () => {
  // Use the real editor renderer; dynamic path avoids imposing its JSX build on export's tsc.
  const module = '../../../../apps/web/src/features/preview/MarkupRenderer.tsx';
  preview = (await import(module)).Lines;
});
test('the showcase matches the editor preview text, styles, icon sequence, and note bodies', () => {
  const editor = document.createElement('div');
  editor.innerHTML = renderToStaticMarkup(
    createElement(preview, { lines: parseMarkup(showcaseText, showcaseGlobals).lines }),
  );
  // The editor retains the enhanced glyph under its CSS mask (font-size: 0).
  editor.querySelectorAll('[class*="enhancedArrow"]').forEach((icon) => {
    icon.textContent = '';
  });
  const actual = renderer.renderDom(lines, { notes: 'inline', interactive: false });
  // The reference's inline note delimiters are the only textual addition to the editor output.
  const text = (value: string) => value.replace(/[()\u2060\s]/g, '');
  expect(text(actual.textContent)).toBe(text(editor.textContent || ''));
  const iconOrder = [...actual.querySelectorAll('[role=img]')].map((element) =>
    (element as Element).getAttribute('aria-label'),
  );
  expect(iconOrder).toEqual([
    'arrow',
    'kinetic',
    'arc',
    'solar',
    'void',
    'stasis',
    'strand',
    'prismatic',
    'primary',
    'special',
    'heavy',
    'barrier',
    'overload',
    'unstoppable',
    'hunter',
    'titan',
    'warlock',
    'kinetic',
    'arc',
    'solar',
    'void',
    'stasis',
    'strand',
    'prismatic',
    'enhancedArrow',
  ]);
  for (const style of ['bold', 'exotic', 'pve', 'pvp'])
    expect(actual.querySelector('.clarity-' + style)).not.toBeNull();
});

test('static docs, examples, machine files, and kit stay complete without scripts', () => {
  const outputs = referenceSite((path) => (path.includes('/lines/') ? plan.bytes : undefined));
  const page = document.createElement('div');
  page.innerHTML = Buffer.from(outputs.get('reference/index.html')!).toString();
  for (const id of [
    'start',
    'live',
    'file',
    'lines',
    'parts',
    'text',
    'languages',
    'updates',
    'versions',
    'display',
    'renderer',
    'agents',
    'kit',
  ])
    expect(page.querySelector('#' + id)).not.toBeNull();
  for (const feature of features) expect(page.querySelector('#part-' + feature.id)).not.toBeNull();
  expect(page.querySelectorAll('script[data-example]')).toHaveLength(features.length);
  expect(outputs.has('llms.txt')).toBe(true);
  const usage = JSON.parse(Buffer.from(outputs.get('reference/kit/usage.json')!).toString());
  expect(usage['symbols/dark/solar.svg']).toContain('Bungie');
  expect(usage['brand/ClarityCut/ClarityCut[wght].woff2']).toContain('OFL');
  const contents = JSON.parse(
    Buffer.from(outputs.get('reference/kit/contents.json')!).toString(),
  ) as string[];
  expect(contents).toContain('brand/ClarityCut/OFL.txt');
  expect(contents).toContain('brand/ClarityCut/FONTLOG.md');
  expect(contents.filter((path) => path.endsWith('.svg'))).toHaveLength(40);
  // Bundled font is the actual editor asset, not a substituted web font.
  expect(outputs.get('reference/kit/symbols/DestinySymbols.woff2')).toEqual(
    readFileSync('apps/web/src/assets/DestinySymbols.woff2'),
  );
});
