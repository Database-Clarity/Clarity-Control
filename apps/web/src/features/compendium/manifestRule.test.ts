import { describe, expect, it } from 'vitest';
import { loadManifestFacts } from './manifestFacts';
import { manifestRule } from './manifestRule';
import type { ReviewSample } from './reviewCategories';
import type { GuidanceReference } from './guidanceSchema';

const facts = loadManifestFacts();
const support = (hash: number) => new Map([[hash, {} as GuidanceReference]]);
const sample = (hash: number) =>
  ({
    manifestFacts: {
      item: structuredClone(facts.items[String(hash)]),
      version: facts.source.manifestVersion,
    },
  }) as ReviewSample;

describe('manifest exclusion rules', () => {
  it.each([
    [5699512, 'catalog:weapon-perk', 'manifest-weapon-stat'],
    [309000506, 'catalog:armor-mod-general', 'manifest-armor-stat'],
    [91797877, 'catalog:weapon-perk', 'manifest-weapon-ornament'],
    [1285109625, 'catalog:armor-mod-general', 'manifest-retired-mod'],
    [299264772, 'catalog:weapon-mod', 'manifest-adept-mod'],
  ])('classifies %i with current owner support', (hash, category, rule) => {
    expect(manifestRule(sample(hash), category, support(hash))?.ruleId).toBe(rule);
    expect(manifestRule(sample(hash), category, new Map())).toBeUndefined();
  });
  it('rejects behavioral bullets and redacted items', () => {
    const entry = sample(5699512);
    entry.manifestFacts!.item.inventory!.description += '\n• Increases damage after a kill';
    expect(manifestRule(entry, 'catalog:weapon-perk', support(5699512))).toBeUndefined();
    entry.manifestFacts!.item.inventory!.redacted = true;
    expect(manifestRule(entry, 'catalog:weapon-perk', support(5699512))).toBeUndefined();
  });
  it('rejects future fizzle', () => {
    const entry = sample(1285109625);
    entry.manifestFacts!.item.inventory!.tooltipNotifications = [
      { displayString: 'This mod will fizzle at the conclusion of the event.' },
    ];
    expect(manifestRule(entry, 'catalog:weapon-mod', support(1285109625))).toBeUndefined();
  });
  it('requires attached facts', () => {
    expect(
      manifestRule({} as ReviewSample, 'catalog:weapon-perk', support(5699512)),
    ).toBeUndefined();
  });
});
