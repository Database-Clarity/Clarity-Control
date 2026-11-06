import { expect, it } from 'vitest';
import { languages, type Tooltip } from '@clarity/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { identityLines, TooltipDiff } from './TooltipDiff';
import fixture from '../compendium/fixtures/triage.json';

const item = fixture.items['2467967826'] as never as Parameters<typeof identityLines>[2] & {
  name: string;
};
const plain: Tooltip = { hash: 1, text: {}, associated: [] };
const withCustom = (name: string, categoryId: string): Tooltip => ({
  ...plain,
  custom: { name, categoryId },
});
const F = 'Category: Stat-only Parts → Parts with Effects';
const R = 'Category: Parts with Effects → Stat-only Parts';
it('renders every published language immediately, including language removals', () => {
  const before: Tooltip = {
    ...plain,
    text: Object.fromEntries(
      languages.map((lang) => [
        lang,
        {
          text: `Historical ${lang}`,
          updatedAt: '2024-01-01T00:00:00Z',
          updatedBy: 'author',
        },
      ]),
    ),
  };
  const html = renderToStaticMarkup(
    createElement(TooltipDiff, {
      before,
      current: plain,
      raw: false,
      eagerLanguages: true,
    }),
  );
  for (const language of languages) expect(html).toContain(`Historical ${language}`);
  expect(html).not.toContain('data-pending-render');
  expect(html).not.toContain('aria-busy="true"');
});
it('shows only the friendly category line when category is the sole change', () => {
  const promoted = withCustom(item!.name, 'attachment-effect');
  expect(identityLines(plain, promoted, item)).toEqual([F]);
  expect(identityLines(promoted, plain, item)).toEqual([R]);
  expect(identityLines(null, promoted, item)).toEqual([F]);
  expect(identityLines(withCustom(item!.name, 'weapon-attachment'), promoted, item)).toEqual([F]);
});
it('keeps identity changes visible next to the category line', () => {
  expect(identityLines(plain, withCustom('Arbitrary', 'attachment-effect'), item)).toEqual([
    F,
    `Custom identity name: ${item!.name} → Arbitrary`,
  ]);
  expect(identityLines(null, withCustom('Arbitrary', 'attachment-effect'), item)).toEqual([
    F,
    `Custom identity name: ${item!.name} → Arbitrary`,
  ]);
  expect(
    identityLines(
      withCustom('Old', 'weapon-attachment'),
      withCustom('New', 'attachment-effect'),
      item,
    ),
  ).toEqual([F, 'Custom identity name: Old → New']);
});
it('keeps the raw line for other custom changes or when the item is unknown', () => {
  const other = withCustom('X', 'other');
  expect(identityLines(plain, other, item)).toEqual([
    `Custom identity: (none) → ${JSON.stringify(other.custom)}`,
  ]);
  expect(identityLines(plain, withCustom('X', 'attachment-effect'))).toHaveLength(1);
  expect(identityLines(plain, withCustom('X', 'attachment-effect'))[0]).toMatch(
    /^Custom identity:/,
  );
  expect(identityLines(other, other, item)).toEqual([]);
});

it('shows styled Compendium snapshot edits, additions and removals in history/review', () => {
  const linked = (text: string): Tooltip => ({
    ...plain,
    compendium: {
      gid: '1',
      rowKey: 'Fixture',
      snapshotAt: '2026-11-02T00:00:00Z',
      snapshot: { plain: text, runs: [{ text, textAlign: 'center' }] },
    },
  });
  for (const [before, current] of [
    [linked('old'), linked('new')],
    [plain, linked('new')],
    [linked('old'), plain],
  ]) {
    const html = renderToStaticMarkup(createElement(TooltipDiff, { before, current }));
    expect(html).toContain('Compendium diff view');
    expect(html).toContain('Before / After');
    expect(html).toContain('text-align:center');
  }
});
