// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { normaliseRuns, type CompendiumCell } from '@clarity/core';
import { CompendiumDiff } from './CompendiumDiff';
import { RichCell } from './RichCell';
import reviewed from './owner-reviewed.json';
import fixture from './fixtures/compendium-links.json';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});
const cell = (plain: string): CompendiumCell => ({ plain, runs: [{ text: plain }] });
const cases: { name: string; before: CompendiumCell; after: CompendiumCell }[] = [
  {
    name: 'merged description',
    before: normaliseRuns([
      { text: 'Header\n', bold: true },
      { text: 'Merged rows\n\nBody', italic: true },
    ]),
    after: normaliseRuns([
      { text: 'Header\n', bold: true },
      { text: 'Merged rows\n\nNew body', italic: true },
    ]),
  },
  {
    name: 'rich runs and links',
    before: {
      plain: 'Bold linked plain',
      runs: [
        { text: 'Bold ', bold: true, color: '#ff0000' },
        { text: 'linked ', href: 'https://example.com/source' },
        { text: 'plain', italic: true },
      ],
    },
    after: {
      plain: 'Bold linked plain',
      runs: [
        { text: 'Bold ', bold: true, color: '#0000ff' },
        { text: 'linked ', href: 'https://example.com/source' },
        { text: 'plain', underline: true },
      ],
    },
  },
  {
    name: 'multiline and mixed alignment',
    before: {
      plain: 'Centre\n\nRight',
      runs: [
        { text: 'Centre\n\n', textAlign: 'center' },
        { text: 'Right', textAlign: 'right', bold: true },
      ],
    },
    after: {
      plain: 'Centre\n\nChanged',
      runs: [
        { text: 'Centre\n\n', textAlign: 'center' },
        { text: 'Changed', textAlign: 'right', bold: true },
      ],
    },
  },
  ...[4019266109, 1888882410].map((hash) => {
    const approval = reviewed.reapproved[hash as unknown as keyof typeof reviewed.reapproved];
    return {
      name: approval.name,
      before: approval.approvedSnapshot as CompendiumCell,
      after: fixture.source.tabs
        .find((t) => t.gid === approval.gid)!
        .rows.find((r) => r.rowIndex === approval.sourceRow)!.cell as CompendiumCell,
    };
  }),
];

// Baseline digests were captured BEFORE consolidating inline wrappers. This signature
// ignores neutral wrappers/React IDs and CSS-hidden formatting, but retains visible
// styles, whitespace/alignment, links, diff context, controls, and full tooltip text.
function signature(host: HTMLElement) {
  const leaves: { text: string; style: string; context: string }[] = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const tooltip = node.parentElement?.closest('[role=tooltip]');
    if (tooltip && tooltip.parentElement?.getAttribute('data-open') !== 'true') continue;
    const ancestors: HTMLElement[] = [];
    for (let p = node.parentElement; p && p !== host; p = p.parentElement) ancestors.unshift(p);
    const style: Record<string, string> = { whiteSpace: 'normal' };
    const context: string[] = [];
    for (const el of ancestors) {
      if (el.className.includes('multiline') || el.className.includes('_cell_')) {
        style.whiteSpace = 'pre-wrap';
        style.overflowWrap = 'anywhere';
      }
      if (el.className.includes('stylePopover')) style.whiteSpace = 'normal';
      for (const key of [
        'color',
        'fontSize',
        'fontWeight',
        'fontStyle',
        'textAlign',
        'whiteSpace',
        'overflowWrap',
        'textDecoration',
      ] as const)
        if (el.style[key]) style[key] = el.style[key];
      if (el.tagName === 'A') context.push('href:' + el.getAttribute('href'));
      if (['INS', 'DEL', 'BUTTON', 'H4'].includes(el.tagName)) context.push(el.tagName);
      if (el.getAttribute('role') === 'tooltip') context.push('tooltip');
    }
    const part = {
      text: node.textContent!,
      style: JSON.stringify(
        Object.fromEntries(Object.entries(style).sort(([a], [b]) => a.localeCompare(b))),
      ),
      context: context.join('/'),
    };
    const previous = leaves.at(-1);
    if (previous?.style === part.style && previous.context === part.context)
      previous.text += part.text;
    else leaves.push(part);
  }
  const controls = [...host.querySelectorAll('button')].map((el) => ({
    text: el.textContent,
    label: el.getAttribute('aria-label'),
    expanded: el.getAttribute('aria-expanded'),
    pressed: el.getAttribute('aria-pressed'),
    described:
      el.hasAttribute('aria-describedby') &&
      !!document.getElementById(el.getAttribute('aria-describedby')!),
  }));
  return {
    digest: createHash('sha256')
      .update(
        JSON.stringify({
          leaves,
          controls,
          tooltips: [...host.querySelectorAll('[role=tooltip]')].map((el) => el.textContent),
        }),
      )
      .digest('hex'),
    text: JSON.stringify(host.textContent),
    controls: controls.length,
    popovers: host.querySelectorAll('[role=tooltip]').length,
  };
}

it.each(cases)(
  'preserves $name styles, alignment, text, controls, and open popovers in both diff views',
  async ({ name, before, after }) => {
    const outputs: unknown[] = [];
    for (const mode of ['changes', 'before-after'] as const) {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      roots.push(root);
      await act(async () => root.render(createElement(CompendiumDiff, { before, after, mode })));
      outputs.push({ mode, closed: signature(host) });
      const toggles = [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')];
      const opened: string[] = [];
      for (const toggle of toggles) {
        await act(async () => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        opened.push(signature(host).digest);
        await act(async () => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
      }
      if (opened.length) outputs.push({ mode, opened });
    }
    expect(outputs).toMatchSnapshot(name);
  },
);
it('keeps standalone picker cells unchanged', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(RichCell, { cell: cell('Picker\n\npreview') })));
  expect(signature(host)).toMatchSnapshot();
});
