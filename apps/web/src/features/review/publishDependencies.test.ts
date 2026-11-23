import { expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { publishDependencies } from './publishDependencies';
import { publishChunks } from './publishDriver';
const t = (hash: number, text: string): Tooltip => ({
  hash,
  text: { en: { text, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'alice' } },
  associated: [],
});
it('keeps removals and edited importers together without reading text being removed', () => {
  const target = t(100, 'import main from 999');
  const edited = t(200, 'No longer imports 100');
  const selected = [target, edited];
  const moves = { 100: { by: 1, at: '2026-11-14T00:00:00Z' } };
  const deps = publishDependencies(
    { 100: target, 200: edited },
    {},
    new Set([100, 200, 999]),
    selected,
    moves,
  );
  expect(deps.get(100)).toEqual([200]);
  expect(deps.get(200)).toContain(100);
  expect(
    publishChunks(
      selected.map((t) => ({
        hash: t.hash,
        digest: 'a'.repeat(64),
        previous: undefined,
        dependencies: deps.get(t.hash),
      })),
    ),
  ).toHaveLength(1);
});

it('observes exact, nested, alias, and cyclic imports through the real resolver', () => {
  const tooltips = Object.fromEntries(
    [
      t(1209885908, 'import main from 2152442764'),
      t(2152442764, 'import main from 300'),
      t(300, 'Resolved'),
      t(400, 'import main from 500'),
      t(500, 'import main from 400'),
    ].map((t) => [t.hash, t]),
  );
  const pending = new Set(Object.values(tooltips).map((t) => t.hash));
  const deps = publishDependencies(tooltips, {}, pending, Object.values(tooltips));
  expect(deps.get(1209885908)).toContain(2152442764);
  expect(deps.get(1209885908)).toContain(300);
  expect(deps.get(400)).toContain(500);
  const alias = t(600, 'import main from 700');
  expect(
    publishDependencies({ ...tooltips, 600: alias }, { 700: { to: 300, kind: 'name' } }, pending, [
      alias,
    ]).get(600),
  ).toContain(300);
});
it('orders pending global libraries and observes imports inside a global title', () => {
  const consumer = t(100, '<title Info [Tip] />');
  const titles = t(3, 'title Tip (\nimport main from 200\n)');
  const target = t(200, 'Resolved');
  const deps = publishDependencies(
    { 100: consumer, 3: titles, 200: target },
    {},
    new Set([3, 200]),
    [consumer],
  );
  expect(deps.get(100)).toContain(3);
  expect(deps.get(100)).toContain(200);
});

it('keeps the 149 reviewed rows together when the selection includes an Inactive removal', () => {
  const aggregate = t(1, 'Global exports');
  const selected = [
    aggregate,
    ...Array.from({ length: 148 }, (_, index) => t(100 + index, 'Tooltip text')),
  ];
  const tooltips = Object.fromEntries(selected.map((tooltip) => [tooltip.hash, tooltip]));
  const dependencies = publishDependencies(
    tooltips,
    {},
    new Set(selected.map(({ hash }) => hash)),
    selected,
    { 100: { by: 1, at: '2026-11-14T00:00:00Z' } },
    true,
  );
  const chunks = publishChunks(
    selected.map(({ hash }) => ({
      hash,
      digest: 'a'.repeat(64),
      previous: undefined,
      dependencies: dependencies.get(hash),
    })),
  );
  expect(chunks.map((chunk) => chunk.length)).toEqual([149]);
  expect(new Set(chunks[0]?.map(({ hash }) => hash))).toEqual(
    new Set(selected.map(({ hash }) => hash)),
  );
});
