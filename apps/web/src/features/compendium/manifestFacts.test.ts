import { expect, it } from 'vitest';
import raw from './manifest-facts.json';
import { loadManifestFacts, manifestFactsSchema } from './manifestFacts';

it('validates the packaged facts and preserves the validated consumer output', () => {
  expect(loadManifestFacts()).toEqual(manifestFactsSchema.parse(raw));
  expect(loadManifestFacts()).toBe(loadManifestFacts());
});

it('still validates explicitly supplied facts', () => {
  expect(() =>
    loadManifestFacts({ ...raw, source: { ...raw.source, manifestSha256: 'bad' } }),
  ).toThrow();
  const facts = loadManifestFacts(raw);
  expect(facts).toEqual(loadManifestFacts());
  expect(facts).not.toBe(loadManifestFacts());
});
