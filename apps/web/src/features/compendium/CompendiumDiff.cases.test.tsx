// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import type { CompendiumCell, CompendiumRun } from '@clarity/core';
import { CompendiumDiff } from './CompendiumDiff';
import {
  projectCompendiumDiff,
  splitLines,
  styleChanges,
  lineAlign,
} from './compendiumDiffProjection';
import shipped from './approved-guidance.v1.json';
import mindspun from './fixtures/mindspun-current.json';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cell = (...runs: CompendiumRun[]): CompendiumCell => ({
  plain: runs.map((run) => run.text).join(''),
  runs,
});
const text = (plain: string) => cell({ text: plain });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});
async function mount(before: CompendiumCell, after: CompendiumCell) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = async (
    b: CompendiumCell,
    a: CompendiumCell,
    mode: 'changes' | 'before-after' = 'changes',
  ) => {
    await act(async () =>
      root.render(createElement(CompendiumDiff, { before: b, after: a, mode })),
    );
  };
  await render(before, after);
  return { host, render };
}

it('uses the first qualifying new line instead of skipping to the most similar line', () => {
  const result = projectCompendiumDiff(
    text('one two three four\none two three six'),
    text('one two three FIVE\none two three four extra'),
  );
  expect(result.lines.map((line) => line.kind)).toEqual(['inline', 'inline']);
});

it('style descriptions are independent of previously visited whitespace patterns', () => {
  const first = styleChanges(
    cell({ text: 'a' }, { text: ' ' }),
    cell({ text: 'a', bold: true }, { text: ' ', italic: true }),
  );
  expect(first.map((change) => change.key)).toEqual(['bold']);
  const second = styleChanges(
    cell({ text: ' ' }, { text: 'b' }),
    cell({ text: ' ', bold: true }, { text: 'b', italic: true }),
  );
  expect(second.map((change) => change.key)).toEqual(['italic']);
});

it('an inline style marker retains the snapshot line, not just changed-style words', () => {
  const before = text('Alpha beta value');
  const after = cell({ text: 'Alpha', bold: true }, { text: ' beta values' });
  const line = projectCompendiumDiff(before, after).lines[0];
  expect(line.kind).toBe('inline');
  if (line.kind !== 'block') expect(line.style?.before.plain).toBe(before.plain);
});

it('a removed line missing alignment inherits even if another old line stores alignment', () => {
  const before = cell({ text: 'Heading\n', textAlign: 'center' }, { text: 'Old words entirely' });
  const after = cell(
    { text: 'Heading\n', textAlign: 'center' },
    { text: 'Replacement text now', textAlign: 'right' },
  );
  const line = projectCompendiumDiff(before, after).lines[1];
  expect(line.kind).toBe('block');
  if (line.kind === 'block') expect(lineAlign(line.before[0])).toBe('right');
});

it('empty, removed-only, added-only, and one-line cells preserve their text', () => {
  expect(projectCompendiumDiff(text(''), text('')).lines).toMatchObject([
    { kind: 'equal', cell: { plain: '' } },
  ]);
  expect(projectCompendiumDiff(text('Old'), text('')).lines).toMatchObject([
    { kind: 'block', before: [{ plain: 'Old' }], after: [] },
  ]);
  expect(projectCompendiumDiff(text(''), text('New')).lines).toMatchObject([
    { kind: 'block', before: [], after: [{ plain: 'New' }] },
  ]);
  for (const plain of ['One', '\n', '\n\n', 'First\n\nLast\n']) {
    expect(
      splitLines(text(plain))
        .map((line) => line.plain)
        .join('\n'),
    ).toBe(plain);
  }
});

it('long lines, combining characters, and emoji are not lost or split', () => {
  const prefix = 'e\u0301 🛰️ '.repeat(1500);
  const before = text(prefix + 'old');
  const after = text(prefix + 'new');
  const result = projectCompendiumDiff(before, after);
  expect(result.lines).toHaveLength(1);
  const line = result.lines[0];
  expect(line.kind).toBe('inline');
  if (line.kind === 'inline') {
    expect(
      line.parts
        .filter((part) => part.kind !== 'removed')
        .map((part) => part.cell.plain)
        .join(''),
    ).toBe(after.plain);
    expect(
      line.parts
        .filter((part) => part.kind !== 'added')
        .map((part) => part.cell.plain)
        .join(''),
    ).toBe(before.plain);
  }
});

it('exactly 0.4 stays inline, and a larger changed-ink share becomes a block', () => {
  expect(projectCompendiumDiff(text('aaa bb'), text('aaa cc')).lines[0].kind).toBe('inline');
  expect(projectCompendiumDiff(text('aaa bbb'), text('aaa ccc')).lines[0].kind).toBe('block');
});

it('colour moves are character-aligned, and different signatures are not hoisted together', () => {
  const changes = styleChanges(
    cell({ text: 'Red', color: '#ff0000' }, { text: ' Blue', color: '#0000ff' }),
    cell({ text: 'Red', color: '#0000ff' }, { text: ' Blue', color: '#ff0000' }),
  );
  expect(changes).toEqual([
    { key: 'colour', from: '#ff0000', to: '#0000ff' },
    { key: 'colour', from: '#0000ff', to: '#ff0000' },
  ]);
  const before = text('A\nB\nC\nD');
  const after = cell({ text: 'A\nB\nC\n', sizePt: 7 }, { text: 'D', bold: true });
  const result = projectCompendiumDiff(before, after);
  expect(result.cellStyle).toBe('size: default → 7 (3 lines)');
  expect(result.lines.filter((line) => line.kind !== 'block' && line.style)).toHaveLength(1);
});

it('Mindspun has duplicate source lines in the old evidence, and neither side loses text', () => {
  const reference = shipped.categories['catalog:subclass-aspect'].references['262821318'];
  const before = reference.link.snapshot as CompendiumCell;
  const after = mindspun.cell as CompendiumCell;
  const first = 'Grapple Melee creates 3 Threadlings on hit.';
  expect(before.plain.split('\n').filter((line) => line === first)).toHaveLength(2);
  const result = projectCompendiumDiff(before, after);
  const oldText = result.lines
    .flatMap((line) =>
      line.kind === 'block'
        ? line.before.map((item) => item.plain)
        : line.kind === 'equal'
          ? [line.cell.plain]
          : [
              line.parts
                .filter((part) => part.kind !== 'added')
                .map((part) => part.cell.plain)
                .join(''),
            ],
    )
    .join('\n');
  const newText = result.lines
    .flatMap((line) =>
      line.kind === 'block'
        ? line.after.map((item) => item.plain)
        : [line.kind === 'equal' ? line.cell.plain : line.after.plain],
    )
    .join('\n');
  expect(oldText).toBe(before.plain);
  expect(newText).toBe(after.plain);
});

it('fold boundaries, unfold/refold, focus, and owner changes reset correctly', async () => {
  const lines = (count: number, label: string) =>
    text(Array.from({ length: count }, (_, i) => label + i).join('\n'));
  const before = lines(7, 'old'),
    after = lines(8, 'new');
  const { host, render } = await mount(before, after);
  const button = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  expect(button.textContent).toContain('5 more removed lines');
  expect(host.querySelectorAll('del > span')).toHaveLength(2);
  button.focus();
  await act(async () => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelectorAll('del > span')).toHaveLength(7);
  expect(document.activeElement).toBe(button);
  await act(async () => button.click());
  expect(host.querySelectorAll('del > span')).toHaveLength(2);
  await act(async () => button.click());
  await render(lines(7, 'other old'), lines(8, 'other new'));
  expect(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
  await render(before, after);
  expect(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
  await render(lines(6, 'six old'), after);
  expect(host.querySelector('button[aria-expanded]')).toBeNull();
});

it('marker hover, focus, click, Enter activation, Esc, blur, and entry changes are isolated', async () => {
  const before = text('Style marker line');
  const after = cell({ text: before.plain, bold: true });
  const { host, render } = await mount(before, after);
  const button = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  const expanded = () => button.getAttribute('aria-expanded');
  await act(async () => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(expanded()).toBe('true');
  await act(async () =>
    button.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
    ),
  );
  expect(expanded()).toBe('false');
  await act(async () => button.focus());
  expect(expanded()).toBe('true');
  await act(async () =>
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(expanded()).toBe('false');
  // Native Enter-to-click activation is represented by click in jsdom.
  await act(async () => button.click());
  expect(expanded()).toBe('true');
  await act(async () => button.blur());
  expect(expanded()).toBe('false');
  await act(async () => button.click());
  await render(text('Other marker line'), cell({ text: 'Other marker line', italic: true }));
  expect(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
  await render(before, after, 'before-after');
  expect(host.querySelectorAll('h4')).toHaveLength(2);
  expect(host.querySelector('button[aria-expanded]')).toBeNull();
  await render(before, after);
  expect(host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
});
