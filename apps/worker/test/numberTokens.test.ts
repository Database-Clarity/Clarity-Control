import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  exportLegacy,
  usesEnglishFallback,
  numberValues,
  publishableHash,
  type Tooltip,
} from '@clarity/core';
import { buildLegacy, type LegacyInput } from '../../../packages/export/src/index.js';
import publisherConfig from '../../../config/publisher.json';
import { Fixture, makePrivateKey, tooltip } from './fixture.js';

let key: string;
let f: Fixture;
const oldAt = '2026-10-01T00:00:00Z';
const newAt = '2026-10-02T00:00:00Z';
const translated = (text = 'Schaden #{=1}.'): Tooltip => ({
  ...tooltip('Damage 5.', oldAt),
  text: {
    en: { text: 'Damage 5.', updatedAt: oldAt, updatedBy: 'alice' },
    de: { text, updatedAt: oldAt, updatedBy: 'dan', sourceUpdatedAt: oldAt },
  },
});
const englishEdit = (base: Tooltip, text = 'Damage 6.', at = newAt) => {
  const next = structuredClone(base);
  next.text.en = { ...next.text.en!, text, updatedAt: at, updatedBy: 'bob' };
  return next;
};
const translationEdit = (base: Tooltip, text = 'Verursacht #{=1} Schaden.') => {
  const next = structuredClone(base);
  next.text.de = { ...next.text.de!, text, updatedAt: newAt };
  return next;
};
const install = (value: Tooltip, capabilities = ['numberTokens']) =>
  f.moveData({ 'tooltips/123.json': value, '.publisher/PIN': { capabilities } });
const saved = () => f.current()['tooltips/123.json'] as Tooltip;
const save = (base: Tooltip | null, next: Tooltip, id = 2) =>
  f.request('/save', 'POST', { changes: [{ hash: next.hash, base, next }], message: 'Edit' }, id);

beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  publisherConfig.enabled = true;
  f = new Fixture(key);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('refuses translator number-map edits before ignoring client maps', async () => {
  const base = translated();
  install(base);
  const next = translationEdit(base);
  next.text.en!.numbers = { ids: [7], next: 8, retired: {} };
  expect((await save(base, next, 4)).status).toBe(403);
  expect(f.commits).toHaveLength(0);
});

it('overwrites a stale client map after a merge, and returns the authoritative map', async () => {
  const base = translated();
  base.text.en!.numbers = { ids: [7], next: 8, retired: {} };
  base.text.de!.text = 'Schaden #{=7}.';
  install({ ...base, associated: [456] });
  const next = englishEdit(base);
  next.text.en!.numbers = { ids: [99], next: 100, retired: { 7: 'WRONG' } };
  const response = await save(base, next);
  expect(response.status).toBe(200);
  const result = (await response.json()).tooltips[0];
  expect(result.associated).toEqual([456]);
  expect(result.text.en.numbers).toEqual({ ids: [7], next: 8, retired: {} });
  expect(numberValues(saved().text.en!).get(7)).toBe('6');
  expect(result.text.de.sourceUpdatedAt).toBe(newAt);
});

it.each(['translator-first', 'editor-first'] as const)(
  'lands concurrent saves: %s',
  async (order) => {
    const base = translated();
    install(base);
    const editor = englishEdit(base);
    const translator = translationEdit(base);
    if (order === 'translator-first') {
      expect((await save(base, translator, 4)).status).toBe(200);
      expect((await save(base, editor)).status).toBe(200);
    } else {
      expect((await save(base, editor)).status).toBe(200);
      expect((await save(base, translator, 4)).status).toBe(200);
    }
    expect(saved().text.en!.text).toBe('Damage 6.');
    expect(saved().text.de).toMatchObject({
      text: translator.text.de!.text,
      updatedBy: 'dan',
      sourceUpdatedAt: newAt,
    });
  },
);

it('a CAS retry recomputes carry against the new translator head', async () => {
  const base = translated();
  install(base);
  f.beforePatch = () => {
    f.beforePatch = undefined;
    f.moveData({ 'tooltips/123.json': translationEdit(base) });
  };
  expect((await save(base, englishEdit(base))).status).toBe(200);
  expect(saved().text.de).toMatchObject({
    text: 'Verursacht #{=1} Schaden.',
    sourceUpdatedAt: newAt,
  });
  expect(f.subrequests).toBeLessThanOrEqual(50);
});

it('an English retry keeps the landed carry, and two real translator edits conflict', async () => {
  const base = translated();
  install(base);
  const editor = englishEdit(base);
  expect((await save(base, editor)).status).toBe(200);
  const landed = structuredClone(saved());
  expect((await save(base, editor)).status).toBe(200);
  expect(saved()).toEqual(landed);
  expect((await save(landed, translationEdit(landed), 4)).status).toBe(200);
  const response = await save(landed, translationEdit(landed, 'Andere #{=1}.'), 4);
  expect(response.status).toBe(409);
  expect((await response.json()).conflicts[0].fields).toContain('text.de');
});

it.each([
  ['Damage 7.', true],
  ['Damage changed to 7.', false],
] as const)(
  'requalifies a stale translator through two English saves ending in %s',
  async (last, current) => {
    const base = translated();
    install(base);
    expect((await save(base, englishEdit(base))).status).toBe(200);
    const first = structuredClone(saved());
    expect((await save(first, englishEdit(first, last, '2026-10-03T00:00:00Z'))).status).toBe(200);
    // A text edit retires the old token; this language already referenced it at the head.
    expect((await save(base, translationEdit(base), 4)).status).toBe(200);
    expect(saved().text.de!.sourceUpdatedAt).toBe(current ? '2026-10-03T00:00:00Z' : oldAt);
  },
);

it('does not requalify a stale translator whose new text lacks changed-token coverage', async () => {
  const base = translated();
  install(base);
  expect((await save(base, englishEdit(base))).status).toBe(200);
  expect((await save(base, translationEdit(base, 'Schaden 5.'), 4)).status).toBe(200);
  expect(saved().text.de!.sourceUpdatedAt).toBe(oldAt);
});

it('writes the per-tooltip carry trailer immediately after Clarity-Changed, only for carried rows', async () => {
  const a = translated();
  a.text.fr = { ...a.text.de!, text: 'Dégâts #{=1}.' };
  const b = { ...translated(), hash: 456 };
  b.text.it = { ...b.text.de!, text: 'Danni #{=1}.' };
  delete b.text.de;
  const c = { ...translated('Schaden 5.'), hash: 777 };
  install(a);
  f.moveData({ 'tooltips/456.json': b, 'tooltips/777.json': c });
  const response = await f.request('/save', 'POST', {
    changes: [a, b, c].map((base) => ({ hash: base.hash, base, next: englishEdit(base) })),
    message: 'Balance',
  });
  expect(response.status).toBe(200);
  expect(f.commits[0].message).toBe(
    'Balance\n\nClarity-Changed: 123=en,de,fr;456=en,it;777=en\nClarity-Carried: 123=de,fr;456=it',
  );
  const base = structuredClone(saved());
  expect((await save(base, translationEdit(base), 4)).status).toBe(200);
  expect(f.commits.at(-1)!.message).not.toContain('Clarity-Carried:');
});

it.each(['// #{=1}', '/* #{=1} */'])(
  'freezes existing retired references in %s, refuses new ones',
  async (comment) => {
    const base = translated(comment);
    install(base);
    expect((await save(base, englishEdit(base, 'No damage.'))).status).toBe(200);
    expect(saved().text.en!.numbers!.retired).toEqual({ 1: '5' });
    const head = structuredClone(saved());
    expect((await save(head, translationEdit(head, comment + '\nText'), 4)).status).toBe(200);
    const next = structuredClone(saved());
    next.text.fr = { ...next.text.de!, text: comment };
    const response = await save(saved(), next);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain(
      'Number #{=1} was removed from English; reload',
    );
  },
);

it('prunes unreferenced retired numbers on the next English save', async () => {
  const base = translated();
  install(base);
  expect((await save(base, englishEdit(base, 'No damage.'))).status).toBe(200);
  const head = structuredClone(saved());
  expect((await save(head, translationEdit(head, 'Kein Schaden.'), 4)).status).toBe(200);
  const current = structuredClone(saved());
  expect(
    (await save(current, englishEdit(current, 'Still no damage.', '2026-10-03T00:00:00Z'))).status,
  ).toBe(200);
  expect(saved().text.en!.numbers!.retired).toEqual({});
});

it.each([
  '#{=99}',
  '#{=0}',
  '#{=x}',
  '#{=1',
  '// #{=99}',
  '/* #{=x} */',
  'import #{=1} from 123',
  '<title [#{=1}] />',
  '${5+#{=1}}',
])('refuses invalid or misplaced token %s', async (text) => {
  const base = translated();
  install(base);
  expect((await save(base, translationEdit(base, text), 4)).status).toBe(422);
  expect(f.commits).toHaveLength(0);
});

it('refuses tokens in English and global documents', async () => {
  const base = translated();
  install(base);
  expect((await save(base, englishEdit(base, 'Damage #{=1}.'))).status).toBe(422);
  const global = { ...translated(), hash: 2 };
  f.moveData({ 'tooltips/2.json': global });
  expect((await save(global, translationEdit(global))).status).toBe(422);
});

it('literal-to-token conversion keeps stamps, and refuses forged conversion stamps', async () => {
  const base = translated('Schaden 5.');
  install(base);
  const next = structuredClone(base);
  next.text.de!.text = 'Schaden #{=1}.';
  expect((await save(base, next, 4)).status).toBe(200);
  install(base);
  next.text.de!.updatedAt = newAt;
  expect((await save(base, next, 4)).status).toBe(422);
});

it.each([false, true])(
  'requires an enabled, capable publisher on save (enabled=%s)',
  async (enabled) => {
    publisherConfig.enabled = enabled;
    const base = translated();
    install(base, []);
    const response = await save(base, translationEdit(base), 4);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('numberTokens');
    expect(f.commits).toHaveLength(0);
  },
);

it('checks capability for a token brought in only by the merged head', async () => {
  const base = translated('Schaden 5.');
  install(translated(), []);
  const next = { ...base, associated: [456] };
  expect((await save(base, next)).status).toBe(422);
  expect(f.commits).toHaveLength(0);
});

it.each([[[]], [['numberTokens']]])(
  'publish enforces installed numberTokens capability %j',
  async (capabilities) => {
    const opId = '01K95H00000000000000000001';
    const now = [...opId.slice(0, 10)].reduce(
      (n, c) => n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c),
      0,
    );
    vi.useFakeTimers({ toFake: ['Date'], now });
    try {
      const value = translated('// #{=1}');
      install(value, capabilities);
      f.env.PUBLISH_SIGNING_KEY = generateKeyPairSync('ed25519')
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const response = await f.request(
        '/publish',
        'POST',
        {
          opId,
          hashes: [123],
          expected: { 123: await publishableHash(value, f.aliases) },
        },
        2,
      );
      expect(response.status).toBe(capabilities.length ? 202 : 422);
      expect(f.subrequests).toBeLessThanOrEqual(50);
      if (!capabilities.length) expect((await response.json()).error).toContain('numberTokens');
    } finally {
      vi.useRealTimers();
    }
  },
);

it('releases a retired formula fallback only after that language saves a matching correction', async () => {
  const base = translated('Schaden #{=1}.\nvar d = 20');
  base.text.en!.text = 'Damage ${5+#d}.\nvar d = 10';
  base.text.fr = { ...base.text.de!, text: 'Dégâts #{=1}.\nvar d = 20' };
  install(base);
  expect((await save(base, englishEdit(base, 'Nothing.\nvar d = 10'))).status).toBe(200);
  const retired = structuredClone(saved());
  const render = (item: Tooltip) => {
    const globals: Tooltip[] = [1, 2, 3].map((hash) => ({
      hash,
      associated: [],
      text: { en: { text: '', updatedAt: oldAt, updatedBy: '' } },
    }));
    const facts = Object.fromEntries(
      [1, 2, 3, 123].map((hash) => [hash, { name: 'Probe', type: 'Weapon Perk' }]),
    );
    const perks = exportLegacy([...globals, item], 0, facts);
    const input = JSON.parse(JSON.stringify({ perks })) as LegacyInput;
    return JSON.parse(new TextDecoder().decode(buildLegacy(input, 'clarityV2')))[123].descriptions
      .de;
  };
  expect(usesEnglishFallback(retired, 'de')).toBe(true);
  expect(JSON.stringify(render(retired))).toContain('Nothing.');
  // Later English changes do not rewrite the frozen value or release any language.
  expect(
    (await save(retired, englishEdit(retired, 'Nothing!\nvar d = 99', '2026-10-03T00:00:00Z')))
      .status,
  ).toBe(200);
  const head = structuredClone(saved());
  expect(usesEnglishFallback(head, 'de')).toBe(true);
  expect((await save(head, translationEdit(head, 'Schaden #{=1}.\nvar d = 10'), 4)).status).toBe(
    200,
  );
  expect(usesEnglishFallback(saved(), 'de')).toBe(false);
  expect(usesEnglishFallback(saved(), 'fr')).toBe(true);
  expect(JSON.stringify(render(saved()))).toContain('Schaden 15');
  expect(saved().text.en!.numbers!.retired[1]).toMatchObject({
    value: '${5+10}',
    fallback: ['fr'],
  });
});

it.each([
  '20',
  '10 // comment',
  '10\nvar d = 10',
  '10\nvar d5 = 2',
  '10\nimport stats from 456',
  '#{=2}',
])('keeps fallback when corrected local is still unproven: %s', async (value) => {
  const base = translated('Schaden #{=1}.\nvar d = 20');
  base.text.en!.text = 'Damage ${5+#d}.\nvar d = 10';
  install(base);
  expect((await save(base, englishEdit(base, 'Nothing.\nvar d = 99'))).status).toBe(200);
  const head = structuredClone(saved());
  expect(
    (await save(head, translationEdit(head, `Neuer Schaden #{=1}.\nvar d = ${value}`), 4)).status,
  ).toBe(200);
  expect(usesEnglishFallback(saved(), 'de')).toBe(true);
});

it('retains legacy fallback entries without provenance after a correction', async () => {
  const base = translated('Schaden #{=1}.\nvar d = 20');
  base.text.en!.text = 'Nothing.';
  base.text.en!.numbers = {
    ids: [],
    next: 2,
    retired: { 1: { value: '${5+10}', fallback: ['de'] } },
  };
  install(base);
  expect((await save(base, translationEdit(base, 'Schaden #{=1}.\nvar d = 10'), 4)).status).toBe(
    200,
  );
  expect(usesEnglishFallback(saved(), 'de')).toBe(true);
});
