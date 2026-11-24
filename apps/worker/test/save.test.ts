import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportLegacy,
  publishableHash,
  usesEnglishFallback,
  type Permissions,
  type Tooltip,
} from '@clarity/core';
import { config, Fixture, makePrivateKey, sha, tooltip } from './fixture.js';

// The legacy /push-live exporter (switch OFF) under test; the checked-in switch is ON since
// PUB-ENABLE, and these paths stay for the publisher rollback.
vi.mock('../../../config/publisher.json', () => ({ default: { enabled: false } }));

let key: string;
let fixture: Fixture;
beforeAll(async () => {
  key = await makePrivateKey();
});
beforeEach(() => {
  fixture = new Fixture(key);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const change = (base = tooltip(), next = tooltip('mine')) => ({
  changes: [{ hash: 123, base, next }],
  message: 'Edit tooltip',
});

describe('whole-number write validation', () => {
  it.each([
    ['en', '1.#{g}'],
    ['de', '#{g}.5'],
    ['de', '#{g},000'],
    ['de', '#{g}0'],
    ['de', '${#g}0'],
    ['de', '#x #x0\nvar x = 1'],
    ['de', '#g #g0'],
    ['en', '1/* x */#{g}'],
    ['de', '5/* x */\n#{g}'],
    ['de', '#{=1}#{=2}'],
    ['en', '${#g * 2}.${#g * 2}'],
  ] as const)('refuses %s %s without writing or loading globals', async (lang, text) => {
    const next = tooltip('mine');
    next.text[lang] = {
      text,
      updatedAt: '2026-10-02T00:00:00Z',
      updatedBy: 'dan',
      ...(lang === 'de' ? { sourceUpdatedAt: next.text.en!.updatedAt } : {}),
    };
    const response = await fixture.request('/save', 'POST', change(tooltip(), next));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/whole number|Use braces/);
    expect(fixture.commits).toHaveLength(0);
  });
  it('accepts a separated braced global', async () => {
    const next = tooltip('mine');
    next.text.en!.text = '#{g} 0';
    expect((await fixture.request('/save', 'POST', change(tooltip(), next))).status).toBe(200);
  });
});

describe('save permission matrix', () => {
  it('returns server time after the commit on a non-cacheable cross-origin response', async () => {
    const before = Date.now();
    const response = await fixture.request('/save', 'POST', change());
    const after = Date.now();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.savedAt).toBeGreaterThanOrEqual(before);
    expect(result.savedAt).toBeLessThanOrEqual(after);
    expect(result.commit).toBe(fixture.dataHead);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects stale alias drafts and creates with a clear canonical target and no writes', async () => {
    fixture.aliases[123] = { to: 456, kind: 'frame' };
    const response = await fixture.request('/save', 'POST', change());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: 'Tooltip 123 is an alias; edit canonical tooltip 456',
    });
    const created = await fixture.request('/save', 'POST', {
      changes: [{ hash: 123, base: null, next: tooltip('new alias') }],
      message: 'Create',
    });
    expect(created.status).toBe(422);
    expect(fixture.commits).toHaveLength(0);
  });
  it.each([1, 2, 3])('allows role id %s and credits the editor, not the bot', async (id) => {
    const response = await fixture.request('/save', 'POST', change(), id);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({
      commit: fixture.dataHead,
      tooltips: [tooltip('mine')],
      savedAt: expect.any(Number),
    });
    expect(fixture.commits[0]).toMatchObject({
      author: {
        name: config.users[String(id)].login,
        email: `${id}+${config.users[String(id)].login}@users.noreply.github.com`,
      },
      committer: { name: 'clarity-test[bot]', email: 'clarity-test[bot]@users.noreply.github.com' },
    });
  });

  it('denies unknown identities', async () => {
    expect((await fixture.request('/save', 'POST', change(), 5)).status).toBe(403);
    expect(fixture.commits).toHaveLength(0);
  });

  it('allows translators to change only their assigned language', async () => {
    const next = tooltip();
    next.text.de = {
      text: 'Deutsch',
      updatedAt: '2026-10-02T00:00:00Z',
      updatedBy: 'dan',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    };
    expect((await fixture.request('/save', 'POST', change(tooltip(), next), 4)).status).toBe(200);
  });

  it('rejects the translator null-base creation repro without writing', async () => {
    const response = await fixture.request(
      '/save',
      'POST',
      {
        message: 'Create',
        changes: [
          {
            hash: 125,
            base: null,
            next: {
              hash: 125,
              text: {
                de: { text: 'Deutsch', updatedAt: '2026-11-03T00:00:00Z', updatedBy: 'dan' },
              },
              associated: [],
            },
          },
        ],
      },
      4,
    );
    expect(response.status).toBe(403);
    expect(fixture.commits).toHaveLength(0);
  });

  it.each(['en', 'fr', 'associated', 'compendium', 'legacy', 'custom'])(
    'rejects translator changes to %s',
    async (field) => {
      const next = tooltip();
      if (field === 'en' || field === 'fr') {
        next.text[field] = {
          text: 'forbidden',
          updatedAt: '2026-10-02T00:00:00Z',
          updatedBy: 'dan',
        };
      } else if (field === 'associated') next.associated = [999];
      else if (field === 'compendium')
        next.compendium = {
          gid: '1662574278',
          rowKey: 'Demo',
          snapshot: { plain: '', runs: [] },
          snapshotAt: '2026-10-02T00:00:00Z',
        };
      else if (field === 'legacy') next.legacy = { uploadedBy: 'spoofed' };
      else next.custom = { name: 'custom', categoryId: 'none' };
      expect((await fixture.request('/save', 'POST', change(tooltip(), next), 4)).status).toBe(403);
      expect(fixture.commits).toHaveLength(0);
    },
  );

  it('preserves unowned head fields even when a translator forges the base', async () => {
    const base = tooltip('forged English');
    const next = structuredClone(base);
    next.text.de = {
      text: 'Deutsch',
      updatedAt: '2026-10-02T00:00:00Z',
      updatedBy: 'dan',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    };
    const response = await fixture.request('/save', 'POST', change(base, next), 4);
    expect(response.status).toBe(200);
    expect(fixture.current()['tooltips/123.json']).toMatchObject({
      text: { en: { text: 'original' }, de: { text: 'Deutsch' } },
    });
  });
});

describe('save concurrency', () => {
  it('merges different languages and association sets', async () => {
    const base = tooltip();
    const head = tooltip();
    head.text.fr = { text: 'bonjour', updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'bob' };
    head.associated = [77];
    fixture.moveData({ 'tooltips/123.json': head });
    const next = tooltip('mine');
    next.associated = [88];
    const response = await fixture.request('/save', 'POST', change(base, next));
    expect(response.status).toBe(200);
    expect((await response.json()).tooltips[0]).toMatchObject({
      associated: [88, 77],
      text: { en: { text: 'mine' }, fr: { text: 'bonjour' } },
    });
    expect(fixture.commits[0].message).toBe('Edit tooltip\n\nClarity-Changed: 123=en,associations');
  });

  it('returns all conflicts and writes nothing, including other tooltips', async () => {
    fixture.moveData({ 'tooltips/123.json': tooltip('theirs') });
    const request = change();
    request.changes.push({
      hash: 124,
      base: { ...tooltip(), hash: 124 },
      next: { ...tooltip('other'), hash: 124 },
    });
    const response = await fixture.request('/save', 'POST', request);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      conflicts: [
        {
          hash: 123,
          base: tooltip(),
          head: tooltip('theirs'),
          headCommit: fixture.dataHead,
          next: tooltip('mine'),
          fields: ['text.en'],
        },
        {
          hash: 124,
          base: { ...tooltip(), hash: 124 },
          head: null,
          next: { ...tooltip('other'), hash: 124 },
          fields: ['$exists'],
        },
      ],
    });
    expect(fixture.commits).toHaveLength(0);
  });

  it('restarts from head and merges after a non-fast-forward race', async () => {
    fixture.beforePatch = () => {
      const head = tooltip();
      head.text.de = { text: 'parallel edit', updatedAt: '2026-10-02T00:00:00Z', updatedBy: 'dan' };
      fixture.moveData({ 'tooltips/123.json': head });
    };
    const response = await fixture.request('/save', 'POST', change());
    expect(response.status).toBe(200);
    expect(fixture.commits).toHaveLength(2);
    expect(fixture.current()['tooltips/123.json']).toMatchObject({
      text: { en: { text: 'mine' }, de: { text: 'parallel edit' } },
    });
    expect(fixture.commits.at(-1)!.message).toBe('Edit tooltip\n\nClarity-Changed: 123=en');
  });

  it('rechecks revoked permissions on a ref race', async () => {
    fixture.beforePatch = () =>
      fixture.moveData({
        'config/permissions.json': {
          users: { '1': { login: 'alice', role: 'maintainer' } },
        } satisfies Permissions,
      });

    const response = await fixture.request('/save', 'POST', change(), 2);
    expect(response.status).toBe(403);
    expect(fixture.current()['tooltips/123.json']).toEqual(tooltip());
  });

  it('bounds ref-update retries without claiming a successful save', async () => {
    fixture.patchRaces = 3;
    const response = await fixture.request('/save', 'POST', change());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Data branch kept moving; reload and retry your save',
    });
    expect(fixture.commits).toHaveLength(3);
    expect(fixture.current()['tooltips/123.json']).toEqual(tooltip());
  });

  it('creates new tooltips with null base and rejects duplicate changes or hash mismatches', async () => {
    const input = {
      changes: [{ hash: 125, base: null, next: { ...tooltip(), hash: 125 } }],
      message: 'Create',
    };
    expect((await fixture.request('/save', 'POST', input)).status).toBe(200);
    expect((await fixture.request('/save', 'POST', change())).status).toBe(200);
    const duplicate = change();
    duplicate.changes.push(duplicate.changes[0]);
    expect((await fixture.request('/save', 'POST', duplicate)).status).toBe(400);
    const mismatch = change();
    mismatch.changes[0].next.hash = 999;
    expect((await fixture.request('/save', 'POST', mismatch)).status).toBe(400);
  });

  it('returns a conflict when two users both create the same hash', async () => {
    const next: Tooltip = tooltip('new');
    const response = await fixture.request('/save', 'POST', {
      changes: [{ hash: 123, base: null, next }],
      message: 'Create',
    });
    expect(response.status).toBe(409);
    expect(fixture.commits).toHaveLength(0);
  });

  it('acknowledges retried edits and creations without a second commit', async () => {
    const existing = tooltip('edited');
    const created = { ...tooltip('created'), hash: 125 };
    const input = {
      changes: [
        { hash: 123, base: tooltip(), next: existing },
        { hash: 125, base: null, next: created },
      ],
      message: 'Save drafts',
    };
    const first = await fixture.request('/save', 'POST', input);
    expect(first.status).toBe(200);
    const retried = {
      ...input,
      changes: input.changes.map((change) => ({
        ...change,
        next: {
          ...change.next,
          text: { en: { ...change.next.text.en!, updatedAt: '2026-11-20T00:00:00Z' } },
        },
      })),
    };
    const second = await fixture.request('/save', 'POST', retried);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      commit: fixture.dataHead,
      tooltips: [existing, created],
    });
    expect(fixture.commits).toHaveLength(1);
  });
});

describe('sandbox set-bonus creation follows existing armor permissions', () => {
  it.each([1, 2, 3, 4])('uses the existing role rule for user %s', async (id) => {
    const next: Tooltip = {
      ...tooltip('Set-bonus text'),
      hash: 3333333333,
      custom: { name: 'Example Set (2 pc): Bonus', categoryId: 'armor-set-bonus' },
    };
    const response = await fixture.request(
      '/save',
      'POST',
      {
        changes: [{ hash: next.hash, base: null, next }],
        message: 'Create set bonus',
      },
      id,
    );
    expect(response.status).toBe(id === 4 ? 403 : 200);
    expect(fixture.commits).toHaveLength(id === 4 ? 0 : 1);
  });
});

describe('save change trailer', () => {
  it('emits one per-tooltip trailer for a mixed-language batch, after user text', async () => {
    const next = tooltip('mine');
    next.associated = [77];
    const german: Tooltip = {
      hash: 124,
      associated: [],
      text: { de: { ...tooltip().text.en!, text: 'Deutsch' } },
    };
    const response = await fixture.request('/save', 'POST', {
      message: 'Batch\n\nClarity-Changed: 123=fr',
      changes: [
        { hash: 123, base: tooltip(), next },
        { hash: 124, base: null, next: german },
      ],
    });
    expect(response.status).toBe(200);
    expect(fixture.commits[0].message).toBe(
      'Batch\n\nClarity-Changed: 123=fr\n\nClarity-Changed: 123=en,associations;124=de',
    );
    expect((await response.json()).tooltips).toEqual([next, german]);
  });
  it('labels a no-op without changing the existing save result', async () => {
    expect((await fixture.request('/save', 'POST', change(tooltip(), tooltip()))).status).toBe(200);
    expect(fixture.commits[0].message).toBe('Edit tooltip\n\nClarity-Changed: 123=none');
  });
});

it('includes shown non-language fields and language removal in the save trailer', async () => {
  const before = tooltip();
  before.text.de = { ...before.text.en!, text: 'Deutsch' };
  fixture.moveData({ 'tooltips/123.json': before });
  const next: Tooltip = {
    ...tooltip(),
    custom: { name: 'Custom', categoryId: 'weapon-mod' },
    archive: {
      removedAt: '2026-10-02T00:00:00Z',
      lastSeen: { name: 'Old', categoryId: 'weapon-mod', manifestVersion: 'pinned' },
    },
    compendium: {
      gid: '1662574278',
      rowKey: 'Demo',
      snapshot: { plain: '', runs: [] },
      snapshotAt: '2026-10-02T00:00:00Z',
    },
  };
  expect((await fixture.request('/save', 'POST', change(before, next), 1)).status).toBe(200);
  expect(fixture.commits[0].message).toBe(
    'Edit tooltip\n\nClarity-Changed: 123=de,custom,archive,compendium',
  );
});

it.each([1, 2, 3, 4])(
  'limits text-less Compendium creation to editors and maintainers (role %s)',
  async (id) => {
    const next = {
      hash: 125,
      text: {},
      associated: [],
      compendium: {
        gid: '1662574278',
        rowKey: 'Demo',
        snapshot: { plain: '', runs: [] },
        snapshotAt: '2026-10-02T00:00:00Z',
      },
    };
    const response = await fixture.request(
      '/save',
      'POST',
      {
        changes: [{ hash: 125, base: null, next }],
        message: 'Confirm link',
      },
      id,
    );
    expect(response.status).toBe(id < 3 ? 200 : 403);
    expect(fixture.commits).toHaveLength(id < 3 ? 1 : 0);
  },
);

it('a saved link-only record becomes publishable when text is added', async () => {
  const base: Tooltip = {
    hash: 123,
    text: {},
    associated: [],
    compendium: {
      gid: '1662574278',
      rowKey: 'Demo',
      snapshot: { plain: '', runs: [] },
      snapshotAt: '2026-10-02T00:00:00Z',
    },
  };
  fixture.moveData({ 'tooltips/123.json': base });
  const next = { ...base, text: tooltip('Now written').text };
  const response = await fixture.request(
    '/save',
    'POST',
    { changes: [{ hash: 123, base, next }], message: 'Write tooltip' },
    2,
  );
  expect(response.status).toBe(200);
  expect((await fixture.request('/push-live', 'POST', { hashes: [123] }, 2)).status).toBe(200);
  expect(fixture.live).toMatchObject({
    perks: { 123: { editor: { en: { main: 'Now written' } } } },
  });
});

it.each([2, 3, 4])(
  'requires English when a link-only record gains a translation (role %s)',
  async (id) => {
    const base: Tooltip = { ...tooltip(), text: {} };
    fixture.moveData({ 'tooltips/123.json': base });
    const next: Tooltip = { ...base, text: { de: { ...tooltip().text.en!, text: 'Nur Deutsch' } } };
    const response = await fixture.request(
      '/save',
      'POST',
      { changes: [{ hash: 123, base, next }], message: 'Translate link-only' },
      id,
    );
    expect(response.status).toBe(422);
    expect(fixture.commits).toHaveLength(0);
    expect(fixture.current()['tooltips/123.json']).toEqual(base);
  },
);
it('checks the real head even if a translator forges a written base for a link-only record', async () => {
  fixture.moveData({ 'tooltips/123.json': { ...tooltip(), text: {} } });
  const base = tooltip();
  const next = { ...base, text: { ...base.text, de: { ...base.text.en!, text: 'Nur Deutsch' } } };
  const response = await fixture.request(
    '/save',
    'POST',
    { changes: [{ hash: 123, base, next }], message: 'Forged source' },
    4,
  );
  expect(response.status).toBe(422);
  expect(fixture.commits).toHaveLength(0);
});

describe('still correct', () => {
  const old = '2026-01-01T00:00:00Z';
  const reviewedAt = '2026-06-01T00:00:00Z';
  const revised = '2026-07-01T00:00:00Z';
  const sentAt = '2026-11-01T00:00:00Z';
  const path = 'tooltips/123.json';
  const setup = () => {
    const base = tooltip('Damage increased.', reviewedAt);
    base.text.de = {
      text: 'Mehr Schaden.',
      updatedAt: old,
      updatedBy: 'other',
      sourceUpdatedAt: old,
    };
    fixture.moveData({ [path]: base });
    const next = structuredClone(base);
    next.text.de = {
      ...base.text.de,
      updatedAt: sentAt,
      updatedBy: 'dan',
      sourceUpdatedAt: reviewedAt,
    };
    const proof = { commit: fixture.dataHead, sourceUpdatedAt: reviewedAt };
    return { base, next, proof };
  };
  const send = (base: Tooltip, next: Tooltip, revisions?: Record<string, unknown>) =>
    fixture.request(
      '/save',
      'POST',
      {
        message: 'Checked German',
        changes: [
          { hash: base.hash, base, next, ...(revisions && { translationRevisions: revisions }) },
        ],
      },
      4,
    );

  it('changes only the assigned translation stamps, recovers publishable German, and is retryable', async () => {
    const { base, next, proof } = setup();
    const request = () => send(base, next, { de: proof });
    const first = await request();
    expect(first.status).toBe(200);
    expect((await first.json()).tooltips).toEqual([next]);
    expect(fixture.commits[0]).toMatchObject({
      message: 'Checked German\n\nClarity-Changed: 123=de\nClarity-Still-Correct: 123=de',
      author: { name: 'dan' },
    });
    expect(usesEnglishFallback(base, 'de')).toBe(true);
    expect(usesEnglishFallback(next, 'de')).toBe(false);
    expect(exportLegacy([base], Date.parse(sentAt))[123]).toMatchObject({
      editor: { de: { main: base.text.en!.text, englishFallback: true } },
    });
    expect(exportLegacy([next], Date.parse(sentAt))[123]).toMatchObject({
      editor: { de: { main: next.text.de!.text } },
      updateTracker: { descriptions: { de: { lastUpdate: Date.parse(sentAt), updatedBy: 'dan' } } },
    });
    expect(await publishableHash(base, {})).not.toBe(await publishableHash(next, {}));
    const retry = await request();
    expect(retry.status).toBe(200);
    expect(fixture.commits).toHaveLength(1);
  });

  it('keeps the reviewed source when newer English arrives and accepts a historical restore', async () => {
    const { base, next, proof } = setup();
    const head = structuredClone(base);
    head.text.en = { ...head.text.en!, text: 'Damage reduced.', updatedAt: revised };
    fixture.moveData({ [path]: head });
    const result = await send(base, next, { de: proof });
    expect(result.status).toBe(200);
    const [saved] = (await result.json()).tooltips as Tooltip[];
    expect(saved.text.en).toEqual(head.text.en);
    expect(saved.text.de).toEqual(next.text.de);
    const restored = structuredClone(saved);
    restored.text.de = { ...restored.text.de!, sourceUpdatedAt: old };
    const restore = await send(saved, restored, {
      de: { ...proof, sourceUpdatedAt: old, restore: true },
    });
    expect(restore.status).toBe(200);
    expect((await restore.json()).tooltips).toEqual([restored]);
    expect(usesEnglishFallback(restored, 'de')).toBe(true);
  });

  it('requires proof, assigned language, unchanged bytes, a real source, and the signed-in author', async () => {
    const { base, next, proof } = setup();
    expect((await send(base, next)).status).toBe(422);
    expect((await send(base, next, { fr: proof })).status).toBe(403);
    expect((await send(base, next, { de: { ...proof, commit: sha(99) } })).status).toBe(422);
    const oldSource = {
      ...next,
      text: { ...next.text, de: { ...next.text.de!, sourceUpdatedAt: old } },
    };
    expect((await send(base, oldSource, { de: { ...proof, sourceUpdatedAt: old } })).status).toBe(
      422,
    );
    const futureSource = {
      ...next,
      text: { ...next.text, de: { ...next.text.de!, sourceUpdatedAt: revised } },
    };
    expect(
      (await send(base, futureSource, { de: { ...proof, sourceUpdatedAt: revised } })).status,
    ).toBe(422);
    next.text.de!.updatedBy = 'alice';
    expect((await send(base, next, { de: proof })).status).toBe(422);
    next.text.de!.updatedBy = 'dan';
    next.text.de!.text = 'Mehr Schaden. ';
    expect((await send(base, next, { de: proof })).status).toBe(422);
    expect(fixture.commits).toHaveLength(0);
  });

  it('refuses a confirmation of a removed number and retains the proof in conflicts', async () => {
    const { base, next, proof } = setup();
    const head = structuredClone(base);
    head.text.de!.text = 'Weniger Schaden.';
    fixture.moveData({ [path]: head });
    const conflict = await send(base, next, { de: proof });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).conflicts).toMatchObject([
      { translationRevisions: { de: proof }, fields: ['text.de'] },
    ]);
    base.text.de!.text = next.text.de!.text = 'Schaden: #{=1}';
    base.text.en!.numbers = next.text.en!.numbers = { ids: [], next: 2, retired: { 1: '5' } };
    fixture.moveData({ [path]: base });
    expect((await send(base, next, { de: { ...proof, commit: fixture.dataHead } })).status).toBe(
      422,
    );
    expect(fixture.commits).toHaveLength(0);
  });
});

describe('No translation impact (TR3)', () => {
  // Stored: English at 2026-10-01 and a current German translation of it.
  const translated = (english = 'original', updatedAt = '2026-10-01T00:00:00Z'): Tooltip => {
    const value = tooltip(english, updatedAt);
    value.text.de = {
      text: 'Deutsch',
      updatedAt: '2026-10-02T00:00:00Z',
      updatedBy: 'dan',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    };
    return value;
  };
  /** English wording changed, English revision kept: what the editor sends when ticked. */
  const kept = () => translated('original, fixed');
  const ticked = (next = kept(), base = translated()) => ({
    ...change(base, next),
    noTranslationImpact: true,
  });
  beforeEach(() => fixture.moveData({ 'tooltips/123.json': translated() }));

  it.each([1, 2])(
    'lets role id %s keep the English revision, with the audit trailer',
    async (id) => {
      const response = await fixture.request('/save', 'POST', ticked(), id);
      expect(response.status).toBe(200);
      const [saved] = (await response.json()).tooltips as Tooltip[];
      expect(saved.text.en).toEqual({ ...translated().text.en, text: 'original, fixed' });
      expect(saved.text.de).toEqual(translated().text.de);
      expect(fixture.commits[0].message).toBe(
        'Edit tooltip\n\nClarity-No-Translation-Impact: 123\nClarity-Changed: 123=en',
      );
    },
  );
  it('refuses trials (403) and writes nothing', async () => {
    const response = await fixture.request('/save', 'POST', ticked(), 3);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Only editors and maintainers can mark a save as having no translation impact',
    });
    expect(fixture.commits).toHaveLength(0);
  });
  it('refuses translators: they cannot change English at all', async () => {
    expect((await fixture.request('/save', 'POST', ticked(), 4)).status).toBe(403);
    expect(fixture.commits).toHaveLength(0);
  });
  it('ignores the flag for a translation-only save (no trailer, any role that may save it)', async () => {
    const next = translated();
    next.text.de = { ...next.text.de!, text: 'Neu', updatedAt: '2026-10-03T00:00:00Z' };
    for (const id of [4, 3]) {
      const response = await fixture.request('/save', 'POST', ticked(next), id);
      expect(response.status).toBe(200);
      fixture.moveData({ 'tooltips/123.json': translated() });
    }
    expect(fixture.commits.map(({ message }) => message)).toEqual([
      'Edit tooltip\n\nClarity-Changed: 123=de',
      'Edit tooltip\n\nClarity-Changed: 123=de',
    ]);
  });
  it('ignores the flag when English changes with a new revision or only by markup', async () => {
    const newer = translated('original, fixed', '2026-10-05T00:00:00Z');
    expect((await fixture.request('/save', 'POST', ticked(newer), 2)).status).toBe(200);
    expect(fixture.commits[0].message).toBe('Edit tooltip\n\nClarity-Changed: 123=en');
    fixture.moveData({ 'tooltips/123.json': translated('<solar/>Scorch') });
    const markup = translated('<solar Scorch />');
    expect(
      (await fixture.request('/save', 'POST', ticked(markup, translated('<solar/>Scorch')), 3))
        .status,
    ).toBe(200);
    expect(fixture.commits[1].message).toBe('Edit tooltip\n\nClarity-Changed: 123=en');
  });
  it('refuses a kept English revision without the flag, for every role', async () => {
    for (const id of [1, 2, 3]) {
      const response = await fixture.request('/save', 'POST', change(translated(), kept()), id);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: 'Tooltip 123: English text changed without a new English revision',
      });
    }
    expect(fixture.commits).toHaveLength(0);
  });
  it('refuses a backdated English revision (it would keep translations current unflagged)', async () => {
    const backdated = translated('original, fixed', '2026-09-30T00:00:00Z');
    for (const body of [change(translated(), backdated), ticked(backdated)]) {
      const response = await fixture.request('/save', 'POST', body, 3);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: 'Tooltip 123: the new English revision must be newer than the stored one',
      });
    }
    expect(fixture.commits).toHaveLength(0);
  });
  it('refuses a kept revision that changes its author', async () => {
    const next = kept();
    next.text.en!.updatedBy = 'bob';
    expect((await fixture.request('/save', 'POST', ticked(next), 2)).status).toBe(422);
    expect(fixture.commits).toHaveLength(0);
  });
  it('merge3: a concurrent translator save merges and German stays current', async () => {
    const head = translated();
    head.text.fr = {
      text: 'Francais',
      updatedAt: '2026-10-03T00:00:00Z',
      updatedBy: 'eve',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    };
    head.text.de = { ...head.text.de!, text: 'Deutsch neu', updatedAt: '2026-10-03T00:00:00Z' };
    fixture.moveData({ 'tooltips/123.json': head });
    const response = await fixture.request('/save', 'POST', ticked(), 2);
    expect(response.status).toBe(200);
    const [saved] = (await response.json()).tooltips as Tooltip[];
    expect(saved.text).toEqual({
      en: { ...translated().text.en, text: 'original, fixed' },
      de: head.text.de,
      fr: head.text.fr,
    });
    // Both translations still match the (kept) English revision: neither is outdated.
    expect(saved.text.de?.sourceUpdatedAt).toBe(saved.text.en?.updatedAt);
    expect(saved.text.fr?.sourceUpdatedAt).toBe(saved.text.en?.updatedAt);
    expect(fixture.commits[0].message).toBe(
      'Edit tooltip\n\nClarity-No-Translation-Impact: 123\nClarity-Changed: 123=en',
    );
  });
  it('merge3: a concurrent English change conflicts; the trailer names only kept tooltips', async () => {
    fixture.moveData({ 'tooltips/123.json': translated('theirs', '2026-10-04T00:00:00Z') });
    expect((await fixture.request('/save', 'POST', ticked(), 2)).status).toBe(409);
    expect(fixture.commits).toHaveLength(0);
    fixture.moveData({ 'tooltips/123.json': translated() });
    const other = { ...translated('other', '2026-10-05T00:00:00Z'), hash: 124 };
    fixture.moveData({ 'tooltips/124.json': { ...translated(), hash: 124 } });
    const body = ticked();
    body.changes.push({ hash: 124, base: { ...translated(), hash: 124 }, next: other });
    expect((await fixture.request('/save', 'POST', body, 1)).status).toBe(200);
    expect(fixture.commits[0].message).toBe(
      'Edit tooltip\n\nClarity-No-Translation-Impact: 123\nClarity-Changed: 123=en;124=en',
    );
  });
  // Security review round 1 (M1): stamps of unchanged English, and English re-added after a delete.
  const stampOnly = (updatedAt: string, updatedBy = 'alice', text = 'original') => {
    const next = translated(text, updatedAt);
    next.text.en!.updatedBy = updatedBy;
    return next;
  };
  it('P1: a reworded save followed by a stamp-only save cannot reach a kept revision', async () => {
    const first = translated('original, fixed', '2026-10-20T00:00:00Z');
    expect((await fixture.request('/save', 'POST', change(translated(), first), 3)).status).toBe(
      200,
    );
    fixture.moveData({ 'tooltips/123.json': first });
    const back = stampOnly('2026-10-01T00:00:00Z', 'alice', 'original, fixed');
    const response = await fixture.request('/save', 'POST', change(first, back), 3);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: 'Tooltip 123: unchanged English must keep its stored revision',
    });
  });
  it('P2, P4, P6: unchanged or markup-only English cannot move its stamps (any role)', async () => {
    fixture.moveData({ 'tooltips/123.json': translated('<solar/>Scorch') });
    const markup = translated('<solar Scorch />', '2026-09-01T00:00:00Z');
    const bodies = [
      change(translated('<solar/>Scorch'), markup),
      change(
        translated('<solar/>Scorch'),
        stampOnly('2099-01-01T00:00:00Z', 'alice', '<solar/>Scorch'),
      ),
      change(
        translated('<solar/>Scorch'),
        stampOnly('2026-10-01T00:00:00Z', 'mallory', '<solar/>Scorch'),
      ),
    ];
    for (const body of bodies)
      for (const id of [1, 3]) {
        const response = await fixture.request('/save', 'POST', body, id);
        expect(response.status).toBe(422);
      }
    expect(fixture.commits).toHaveLength(0);
  });
  it("P10: English re-added after a delete must be newer than its translations' source", async () => {
    const withoutEnglish = translated();
    delete withoutEnglish.text.en;
    fixture.moveData({ 'tooltips/123.json': withoutEnglish });
    const readded = translated('reworded', '2026-10-01T00:00:00Z');
    const refused = await fixture.request('/save', 'POST', change(withoutEnglish, readded), 3);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: "Tooltip 123: the new English revision must be newer than its translations' source",
    });
    const fresh = translated('reworded', '2026-10-05T00:00:00Z');
    expect((await fixture.request('/save', 'POST', change(withoutEnglish, fresh), 3)).status).toBe(
      200,
    );
  });
  // Triage 1: translation stamps (O1) and future English revisions (O2).
  it('O1 R5: a reworded English cannot mark an unchanged translation current', async () => {
    const next = translated('original, fixed', '2026-10-20T00:00:00Z');
    next.text.de = { ...next.text.de!, sourceUpdatedAt: '2026-10-20T00:00:00Z' };
    const response = await fixture.request('/save', 'POST', change(translated(), next), 3);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: 'Tooltip 123: unchanged de text must keep its stored revision',
    });
    expect(fixture.commits).toHaveLength(0);
  });
  it('S1: a changed translation must name its English source revision (trial and translator)', async () => {
    for (const user of [3, 4]) {
      const next = translated();
      next.text.de = { ...next.text.de!, text: 'Deutsch neu' };
      delete next.text.de.sourceUpdatedAt;
      const response = await fixture.request('/save', 'POST', change(translated(), next), user);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: 'Tooltip 123: the changed de text needs the English revision it translates',
      });
    }
    // The same in one save with a reworded English.
    const reworded = translated('original, fixed', '2026-10-20T00:00:00Z');
    reworded.text.de = { ...reworded.text.de!, text: 'Deutsch neu' };
    delete reworded.text.de.sourceUpdatedAt;
    expect((await fixture.request('/save', 'POST', change(translated(), reworded), 3)).status).toBe(
      422,
    );
    expect(fixture.commits).toHaveLength(0);
  });
  it('O1 R6: a translation cannot claim a source revision newer than its English', async () => {
    for (const text of ['Deutsch', 'Deutsch neu']) {
      const next = translated();
      next.text.de = { ...next.text.de!, text, sourceUpdatedAt: '2099-01-01T00:00:00Z' };
      const response = await fixture.request('/save', 'POST', change(translated(), next), 4);
      expect(response.status).toBe(422);
    }
    // Changed text stamped against the stored English (the editor's stamp) still saves.
    const honest = translated();
    honest.text.de = { ...honest.text.de!, text: 'Deutsch neu', updatedAt: '2026-10-03T00:00:00Z' };
    expect((await fixture.request('/save', 'POST', change(translated(), honest), 4)).status).toBe(
      200,
    );
  });
  it('O2: refuses an English revision far in the future, except the stored + 1 ms clamp', async () => {
    const future = translated('original, fixed', '2099-01-01T00:00:00Z');
    const refused = await fixture.request('/save', 'POST', change(translated(), future), 2);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: 'Tooltip 123: the English revision is in the future; check your device clock',
    });
    // A stored revision already ahead (another device's clock): the editor's clamp still saves.
    const ahead = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const stored = translated('original', ahead);
    fixture.moveData({ 'tooltips/123.json': stored });
    const clamp = translated('original, fixed', new Date(Date.parse(ahead) + 1).toISOString());
    expect((await fixture.request('/save', 'POST', change(stored, clamp), 2)).status).toBe(200);
  });
  it('a commit message cannot forge the audit line in the final trailer block', async () => {
    const body = {
      ...change(translated(), translated('original, fixed', '2026-10-05T00:00:00Z')),
      message: 'Fix\n\nClarity-No-Translation-Impact: 123',
    };
    expect((await fixture.request('/save', 'POST', body, 2)).status).toBe(200);
    expect(fixture.commits[0].message).toBe(
      'Fix\n\nClarity-No-Translation-Impact: 123\n\nClarity-Changed: 123=en',
    );
  });
});
