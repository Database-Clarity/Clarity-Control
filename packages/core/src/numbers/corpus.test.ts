import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import revisions from './fixtures/sample30.json';
import { numberSlots } from '../markup/numberSlots.js';
import { alignSlots } from './identity.js';
import { numberValues, resolveNumberTokens } from './map.js';
import { lowerConsumerMarkup } from '../markup/braces.js';
import { exportLegacy, type LegacyEntry } from '../exportLegacy.js';

it.each(revisions.revisions)('sample $index, $hash ($date): $kind', (revision) => {
  const aligned = alignSlots(revision.before, revision.after);
  expect(aligned.kind).toBe(revision.kind);
  expect(aligned.map.size).toBe(revision.kept);
  for (const [a, b] of aligned.map)
    if (aligned.kind === 'text') expect(aligned.before[a].scope).toBe(aligned.after[b].scope);
});

it('P7: every real English text tokenises and resolves to identical source and consumer bytes', () => {
  const corpus = JSON.parse(
    gunzipSync(readFileSync(new URL('./fixtures/english.json.gz', import.meta.url))).toString(
      'utf8',
    ),
  ) as { source: string; english: { hash: number; text: string }[] };
  expect(corpus.english.length).toBe(1792);
  for (const { hash, text } of corpus.english) {
    let tokenized = '',
      at = 0;
    numberSlots(text).forEach((slot, index) => {
      tokenized += text.slice(at, slot.from) + `#{=${index + 1}}`;
      at = slot.to;
    });
    tokenized += text.slice(at);
    const resolved = resolveNumberTokens(tokenized, numberValues({ text }));
    expect(resolved, String(hash)).toBe(text);
    const entry = { text, updatedBy: 'fixture', updatedAt: '2026-11-01T00:00:00.000Z' };
    const exported = exportLegacy(
      [{ hash, text: { en: entry, de: { ...entry, text: tokenized } }, associated: [] }],
      0,
    )[hash] as LegacyEntry;
    expect(exported.editor.de?.main, String(hash)).toBe(lowerConsumerMarkup(text));
    expect(exported.editor.de?.main).toBe(exported.editor.en?.main);
  }
});
