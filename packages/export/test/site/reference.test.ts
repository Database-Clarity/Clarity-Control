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
import { safeSitePath } from '../../src/site/build-site.js';
import { behaviorSource } from '../../src/site/reference/behaviors.js';

// Import the exact downloadable ES module, including its unchanged exports.
const renderer = await import(
  `data:text/javascript;base64,${Buffer.from(rendererSource).toString('base64')}`
);
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

test.each(['constructor', 'toString', '__proto__'])(
  'inherited name %s is not a documented symbol or a bundled icon',
  (name) => {
    expect(() => featureTable([name])).toThrow('Undocumented symbol');
    const lines = [{ parts: [{ icon: name, text: 'FALLBACK' }, { text: ' next word' }] }];
    const content = renderer.renderDom(lines);
    expect(content.textContent).toBe('FALLBACK next word');
    expect(content.querySelector('img,[role="img"]')).toBeNull();
    expect(renderer.renderText(lines)).toBe('FALLBACK next word');
  },
);

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

test('DOM symbol runs keep their touching words and leave spaced words outside', () => {
  const content = [
    {
      parts: [
        { text: 'Value 50%' },
        { icon: 'arrow' },
        { text: '40% and ' },
        { icon: 'arc' },
        { text: 'Ionic', style: ['bold'] },
        { text: 'Traces ' },
        { icon: 'enhancedArrow' },
        { text: '10%' },
        { icon: 'solar' },
        { text: ' Scorch' },
      ],
    },
  ];
  const output = renderer.renderDom(content);
  expect([...output.querySelectorAll('.clarity-glue')].map((run) => run.textContent)).toEqual([
    '50%40%',
    'IonicTraces',
    '10%',
  ]);
  expect(output.textContent).toBe('Value 50%40% and IonicTraces 10% Scorch');
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

test('inline notes contain no block rows, and expansion bodies follow the intact source line', () => {
  const content = [
    {
      parts: [
        { text: 'This ' },
        { text: 'refills', note: [{ parts: [{ text: 'From reserves.' }] }] },
        { text: ' the magazine.' },
      ],
    },
  ];
  const inline = renderer.renderDom(content, { notes: 'inline' });
  expect(inline.textContent).toBe('This refills (From reserves.) the magazine.');
  expect(inline.querySelector('.clarity-line .clarity-line')?.tagName).toBe('SPAN');
  const expand = renderer.renderDom(content, { notes: 'expand' });
  const button = expand.querySelector('button');
  button.click();
  expect(expand.firstElementChild.textContent).toBe('This refills the magazine.');
  expect(expand.lastElementChild.classList.contains('clarity-expansion')).toBe(true);
  expect(expand.lastElementChild.hidden).toBe(false);
});

test('a sheet shows only the tapped detail and offers an explicit link action', async () => {
  const { sheetDetails } = await import(
    `data:text/javascript;base64,${Buffer.from(behaviorSource).toString('base64')}`
  );
  const content = [
    {
      parts: [
        { text: 'refills', note: [{ parts: [{ text: 'From reserves.' }] }] },
        { text: 'Clarity', link: 'https://d2clarity.com' },
      ],
    },
  ];
  const host = renderer.renderDom(content, { notes: 'expand' });
  const panel = renderer.renderDetails(content);
  const dialog = document.createElement('dialog');
  dialog.innerHTML = '<h3>Details</h3><div data-body></div>';
  dialog.showModal = () => {
    dialog.open = true;
  };
  document.body.append(host, dialog);
  const cleanup = sheetDetails(host, panel, dialog);
  host.querySelector('button').click();
  expect(dialog.querySelector('[data-body]')!.textContent).toBe('From reserves.');
  expect(dialog.querySelector('h3')!.textContent).toBe('refills');
  expect(dialog.querySelector('.sheet-open-link')).toBeNull();
  host.querySelector('a').click();
  expect(dialog.querySelector('[data-body]')!.textContent).not.toContain('From reserves.');
  expect(dialog.querySelector('.sheet-open-link')?.textContent).toBe('Open link');
  cleanup();
  host.remove();
  dialog.remove();
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
  for (const path of outputs.keys()) expect(safeSitePath(path), path).toBe(true);
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
  expect(page.querySelectorAll('noscript')).toHaveLength(1);
  expect(page.querySelector('main')!.firstElementChild!.tagName).toBe('NOSCRIPT');
  const llms = Buffer.from(outputs.get('llms.txt')!).toString();
  expect(llms).toContain('/reference/v2/lines/en.json');
  expect(llms).not.toContain('partnerships');
  expect(page.textContent).not.toMatch(/Other display options|data usage requirements/);
  const usage = JSON.parse(Buffer.from(outputs.get('reference/kit/usage.json')!).toString());
  expect(usage['symbols/dark/solar.svg']).toContain('MIT licence');
  expect(
    Buffer.from(outputs.get('reference/kit/CREDITS.txt')!).toString().trim().split('\n'),
  ).toEqual([expect.stringContaining('Bungie')]);
  expect(usage['brand/ClarityCut/ClarityCut-Variable.woff2']).toContain('OFL');
  const contents = JSON.parse(
    Buffer.from(outputs.get('reference/kit/contents.json')!).toString(),
  ) as string[];
  expect(contents).toContain('brand/ClarityCut/OFL.txt');
  expect(contents).toContain('brand/ClarityCut/FONTLOG.md');
  expect(contents).toContain('symbols/LICENSE');
  expect(contents.filter((path) => /^brand\/.*\.svg$/.test(path))).toEqual([
    'brand/clarity-icon.svg',
    'brand/clarity-text-dark.svg',
    'brand/clarity-text-light.svg',
  ]);
  expect(contents.filter((path) => path.endsWith('.svg'))).toHaveLength(39);
  // Bundled font is the actual editor asset, not a substituted web font.
  expect(outputs.get('reference/kit/symbols/DestinySymbols.woff2')).toEqual(
    readFileSync('apps/web/src/assets/DestinySymbols.woff2'),
  );
});
