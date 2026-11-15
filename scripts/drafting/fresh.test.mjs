import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { draftDigest, freshPage, sampleInputDigest } from './fresh.mjs';

it('requires exact validation, independent critique, and fresh identity for every rendered row', () => {
  const input = { styleGuide: 'v4.7', guideKitSha256: 'kit', excludedHashes: [100], excludedNames: ['Old tooltip'], items: [{ hash: 200, name: 'Fresh tooltip', group: 'Subclass', ownerPrecedents: [{ hash: 1 }] }] };
  const drafts = { 200: "Freezes the target's Shield.", _meta: { guideKitSha256: 'kit', precedentUse: { 200: [{ hash: 1 }] } } };
  const validation = { accepted: { 200: drafts[200] }, errors: {} };
  const critique = { verdict: 'APPROVE', guideKitSha256: 'kit', draftDigest: draftDigest(drafts), inputDigest: sampleInputDigest(input) };
  const doc = new JSDOM(freshPage(input, drafts, validation, critique)).window.document;
  expect(doc.querySelector('pre').textContent).toBe(drafts[200]);
  expect(doc.querySelectorAll('textarea,button')).toHaveLength(0);
  expect(() => freshPage(input, { ...drafts, 200: 'Changed since critique.' }, validation, critique)).toThrow('exact drafts');
  const oldInput = { ...input, excludedHashes: [200] };
  expect(() => freshPage(oldInput, drafts, validation, { ...critique, inputDigest: sampleInputDigest(oldInput) })).toThrow('Previously shown');
  expect(() => freshPage(input, { ...drafts, _meta: { ...drafts._meta, sourceWarnings: { 200: ['Changed source claim'] } } }, validation, critique)).toThrow('exact drafts');
  expect(() => freshPage(input, drafts, validation, { ...critique, verdict: 'REVISE' })).toThrow('critique');
});
