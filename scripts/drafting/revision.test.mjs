import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { revisionDigest, revisionPage } from './revision.mjs';
import { draftDigest, sampleInputDigest } from './fresh.mjs';

it('gates every revised row and saves only deliberate new verdicts to feedback48', async () => {
  const importHashes = [2077016094, 2733010662, 2734970071, 3458160468];
  const input = { styleGuide: 'v4.8', guideKitSha256: 'kit', items: Array.from({ length: 23 }, (_, n) => ({ hash: importHashes[n] ?? n, name: `Perk ${n}`, ownerFeedback: { verdict: 'change', note: "Owner's exact note." } })) };
  const drafts = { _meta: { guideKitSha256: 'kit', whatChanged: {} } }, validation = { accepted: {}, errors: {} };
  for (const item of input.items) { drafts[item.hash] = "Refills the weapon's magazine."; drafts._meta.whatChanged[item.hash] = 'Clarified the refill target.'; validation.accepted[item.hash] = drafts[item.hash]; }
  const critique = { verdict: 'APPROVE', digestsReproduced: true, guideKitSha256: 'kit', draftDigest: draftDigest(drafts), revisionDigest: revisionDigest(drafts), inputDigest: sampleInputDigest(input), checksByHash: Object.fromEntries(input.items.map(i => [i.hash, 'PASS'])) };
  expect(() => revisionPage(input, drafts, validation, { ...critique, verdict: 'REVISE' })).toThrow('approval');
  expect(() => revisionPage(input, drafts, validation, { ...critique, digestsReproduced: false })).toThrow('approval');
  const changed = structuredClone(drafts); changed._meta.whatChanged[2077016094] = 'Changed after critique.';
  expect(() => revisionPage(input, changed, validation, critique)).toThrow('approval');
  const writes = [], collections = [];
  const dom = new JSDOM(revisionPage(input, drafts, validation, critique), { runScripts: 'dangerously', beforeParse(window) {
    window.claude = { use: async () => ({ doc: path => ({ set: async data => writes.push({ path, data }) }), collection: name => ({ onSnapshot: cb => { collections.push(name); cb({ docs: [] }); } }) }) };
  } });
  await new Promise(resolve => setTimeout(resolve, 0));
  const doc = dom.window.document;
  expect(writes).toEqual([]); expect(collections).toEqual(['feedback48']);
  expect(doc.querySelectorAll('article')).toHaveLength(23);
  expect(doc.querySelector('.note').textContent).toBe("Owner's exact note.");
  expect(doc.querySelector('pre').textContent).toBe(drafts[2077016094]);
  expect(doc.querySelectorAll('.inherited')).toHaveLength(4);
  expect(doc.querySelector('.inherited').textContent).toBe("Inherited from Arc Siphon: its text says 'Mods equipped' (capital M); edit Arc Siphon in the editor if you want it lowercase.");
  doc.querySelector('textarea').value = 'A new note'; doc.querySelector('button[data-v=ok]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(writes).toHaveLength(1); expect(writes[0].path).toBe('feedback48/2077016094');
  expect(writes[0].data).toMatchObject({ verdict: 'ok', note: 'A new note' });
  expect(doc.querySelector('button[data-v=ok]').getAttribute('aria-pressed')).toBe('true');
  dom.window.close();
});
