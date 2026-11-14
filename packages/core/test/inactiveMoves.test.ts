import { expect, it } from 'vitest';
import { exportLegacy } from '../src/exportLegacy.js';
import {
  activeAliases,
  exportWithInactiveMoves,
  inactivePublishableHash,
  selectedInactiveMoves,
  applyInactiveLive,
  type InactiveMoves,
} from '../src/inactiveMoves.js';
import { publishableHash } from '../src/publishableHash.js';
import { tooltip } from './helpers.js';

const moves: InactiveMoves = { 42: { by: 1, at: '2026-11-14T00:00:00Z' } };
const aliases = { 77: { to: 42, kind: 'sandbox' as const } };
const other = (text = 'Other') => ({
  ...tooltip(),
  hash: 99,
  text: {
    en: { ...tooltip().text.en!, text },
  },
});

it('removes selected live rows and old stubs, while unrelated staged decisions stay unpublished', () => {
  const live = exportLegacy([tooltip(), other()], 0, undefined, aliases);
  expect(applyInactiveLive(live, moves, [99], aliases)).toEqual(live);
  expect(Object.keys(applyInactiveLive(live, moves, [42], aliases))).toEqual(['99']);
  expect(live[42]).toBeDefined();
});

it.each(['main', 'secondary'] as const)(
  'fails closed on retained live %s imports and title bodies',
  (field) => {
    const live = exportLegacy([tooltip(), other()], 0, undefined, aliases);
    const entry = live[99];
    if ('aliasOf' in entry) throw new Error('fixture');
    entry.editor.en![field] = 'import main from 77';
    expect(() => applyInactiveLive(live, moves, [42], aliases)).toThrow(/imports inactive/);
    entry.editor.en![field] = '<title Details [Read] />';
    live[3] = {
      ...entry,
      hash: 3,
      editor: {
        en: {
          main: 'title Read (\nimport main from 42\n)',
          secondary: 'title Read (\nimport main from 42\n)',
        },
      },
    };
    expect(() => applyInactiveLive(live, moves, [42], aliases)).toThrow(/imports inactive/);
  },
);

it('limits a partial publish to selected canonical rows and their stub decisions', () => {
  const staged = { ...moves, 77: { ...moves[42]!, inactive: false as const }, 99: moves[42]! };
  expect(selectedInactiveMoves(staged, [99], aliases)).toEqual({ 99: moves[42] });
  expect(selectedInactiveMoves(staged, [42], aliases)).toEqual({ 42: moves[42], 77: staged[77] });
  expect(selectedInactiveMoves(staged, [], aliases)).toEqual({});
});

it('preserves output bytes and digests with an empty file', async () => {
  const input = [tooltip(), other()];
  expect(JSON.stringify(exportWithInactiveMoves(input, 0, undefined, aliases, {}))).toBe(
    JSON.stringify(exportLegacy(input, 0, undefined, aliases)),
  );
  expect(await inactivePublishableHash(tooltip(), aliases, {})).toBe(
    await publishableHash(tooltip(), aliases),
  );
});

it('removes exactly the moved item and its stubs, and restores them on move-out', () => {
  const input = [tooltip(), other()];
  const original = exportLegacy(input, 0, undefined, aliases);
  const expected = { ...original };
  delete expected[42];
  delete expected[77];
  expect(exportWithInactiveMoves(input, 0, undefined, aliases, moves)).toEqual(expected);
  expect(exportWithInactiveMoves(input, 0, undefined, aliases, {})).toEqual(original);
});

it('allows moving a stub alone without removing its canonical tooltip', () => {
  const movedAlias = { 77: moves[42]! };
  expect(
    Object.keys(exportWithInactiveMoves([tooltip()], 0, undefined, aliases, movedAlias)),
  ).toEqual(['42']);
  expect(activeAliases(aliases, movedAlias)).toEqual({});
});

it.each(['import main from 42', 'import main from 77'])(
  'fails closed when a retained item reads inactive text: %s',
  (text) => {
    expect(() =>
      exportWithInactiveMoves([tooltip(), other(text)], 0, undefined, aliases, moves),
    ).toThrow(/imports inactive/);
  },
);

it('fails closed for associations and required globals', () => {
  expect(() =>
    exportWithInactiveMoves(
      [tooltip(), { ...other(), associated: [77] }],
      0,
      undefined,
      aliases,
      moves,
    ),
  ).toThrow(/associates inactive/);
  expect(() => exportWithInactiveMoves([tooltip()], 0, undefined, {}, { 2: moves[42]! })).toThrow(
    /required output input/,
  );
});

it('uses a stable removal digest, so editing inactive text does not re-export it', async () => {
  expect(await inactivePublishableHash(tooltip(), aliases, moves)).not.toBe(
    await publishableHash(tooltip(), aliases),
  );
  expect(await inactivePublishableHash({ ...other('Changed'), hash: 42 }, aliases, moves)).toBe(
    await inactivePublishableHash(tooltip(), aliases, moves),
  );
});

it('checks nested imports, title bodies, missing cells, and cycles with the real resolver', () => {
  const movedText = tooltip();
  const middle = { ...other('import main from 42'), hash: 88 };
  const cases = [
    [movedText, middle, other('import main from 88')],
    [
      movedText,
      { ...other('title Details (\nimport main from 77\n)'), hash: 3 },
      other('<title Read [Details] />'),
    ],
    [other('import main from 42')],
    [
      movedText,
      { ...other('import main from 99\nimport main from 42'), hash: 88 },
      other('import main from 88'),
    ],
  ];
  for (const input of cases)
    expect(() => exportWithInactiveMoves(input, 0, undefined, aliases, moves)).toThrow(
      /imports inactive/,
    );
});

it('keeps the canonical target of a retained alias when an intermediate stub is moved', () => {
  const chain = { ...aliases, 66: { to: 77, kind: 'frame' as const } };
  const movedStub = { 77: moves[42]! };
  expect(activeAliases(chain, movedStub)).toEqual({ 66: { to: 42, kind: 'frame' } });
  const result = exportWithInactiveMoves([tooltip()], 0, undefined, chain, movedStub);
  expect(result[66]).toMatchObject({ aliasOf: 42 });
  expect(result[77]).toBeUndefined();
});
