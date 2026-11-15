import { expect, test } from 'vitest';
import { publishableHash, tooltipSchema } from '../../packages/core/src/index.js';
import { blobContent } from '../mult-write/rewrite.js';
import { planTypedArrows, rewriteTypedArrow } from './arrow-symbol-plan.js';

test('uses quick-fix context and original offsets across successive arrows', () => {
  expect(rewriteTypedArrow('🠚 A 🠚 B')).toEqual({
    text: '<arrow/> A <arrow/> B',
    rewritten: [0, 5],
    refused: [],
  });
  expect(rewriteTypedArrow('<bold 🠚 🠚 />').text).toBe('<bold <arrow/> <arrow/> />');
  for (const text of ['<link 🠚 [url] />', '<title 🠚 />', '<bold 🠚']) {
    expect(rewriteTypedArrow(text)).toMatchObject({
      text,
      rewritten: [],
      refused: [text.indexOf('🠚')],
    });
  }
  expect(rewriteTypedArrow('-> → <arrow/>').rewritten).toEqual([]);
});

test('plan preserves all stored metadata, changes only text lines, and is deterministic', () => {
  const before = blobContent({
    hash: 10,
    associated: [],
    legacy: { inLiveDatabase: true, uploadToLive: false },
    text: { en: { text: '🠚 A 🠚', updatedAt: '2025-01-01T00:00:00.000Z', updatedBy: 'Someone' } },
  });
  const { plan, refused } = planTypedArrows({ 'tooltips/10.json': before });
  expect(refused).toEqual([]);
  expect(plan.changes).toHaveLength(1);
  expect(plan.changes[0]!.jsonLines).toHaveLength(1);
  expect(plan.changes[0]!.texts[0]!.arrows).toBe(2);
  const after = JSON.parse(plan.changes[0]!.after);
  expect(after.text.en).toEqual({
    text: '<arrow/> A <arrow/>',
    updatedAt: '2025-01-01T00:00:00.000Z',
    updatedBy: 'Someone',
  });
  expect(planTypedArrows({ 'tooltips/10.json': before }).plan).toEqual(plan);
  expect(planTypedArrows({ 'tooltips/10.json': plan.changes[0]!.after }).plan.changes).toEqual([]);
  expect(() => planTypedArrows({ 'tooltips/10.json': JSON.stringify(JSON.parse(before)) })).toThrow(
    /canonical/,
  );
});

test('documents the current pending-change blocker without changing hash behavior', async () => {
  const before = tooltipSchema.parse({
    hash: 10,
    associated: [],
    text: { en: { text: '🠚 A', updatedAt: '2025-01-01T00:00:00.000Z', updatedBy: 'Someone' } },
  });
  const after = structuredClone(before);
  after.text.en!.text = '<arrow/> A';
  expect(await publishableHash(before)).not.toBe(await publishableHash(after));
});
