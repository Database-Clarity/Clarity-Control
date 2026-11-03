// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { createDraftStore } from './drafts';
import {
  changedVariants,
  createPreviewReviewStore,
  reviewKey,
  reviewSignature,
} from './previewReview';
import type { Drafts, DraftStorage } from '../services/draftStorage';

function tooltip(hash: number, text: string, extra: Partial<Tooltip> = {}): Tooltip {
  return {
    hash,
    text: { en: { text, updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'owner' } },
    associated: [],
    ...extra,
  };
}
const base = tooltip(10, 'Original');
const variant = tooltip(11, 'Variant');

function memoryDrafts(): DraftStorage {
  let value: Drafts = {};
  const users = new Map<string, DraftStorage>();
  const storage: DraftStorage = {
    async read() {
      return structuredClone(value);
    },
    async write(drafts) {
      value = structuredClone(drafts);
    },
    forUser(id) {
      let bucket = users.get(id);
      if (!bucket) {
        let own: Drafts = {};
        bucket = {
          async read() {
            return structuredClone(own);
          },
          async write(drafts) {
            own = structuredClone(drafts);
          },
        };
        users.set(id, bucket);
      }
      return bucket;
    },
  };
  return storage;
}
function memoryLocal() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

let desktop = true;
let canonical: Record<number, number> = {};
let bases: Record<number, Tooltip> = {};
let local = memoryLocal();
let drafts: ReturnType<typeof createDraftStore>;

function setup() {
  const store = createPreviewReviewStore({
    drafts,
    canonicalOf: (hash) => canonical[hash] ?? hash,
    baseOf: (hash) => bases[hash],
    desktop: () => desktop,
    storage: () => local,
  });
  const stop = store.getState().start();
  return { store, stop };
}
async function ready() {
  await drafts.getState().activate(null);
}
const edit = (target: Tooltip, text: string) => drafts.getState().edit(target, 'en', text, 'alice');
const host = { show: () => {} };

beforeEach(() => {
  desktop = true;
  canonical = { 11: 10 };
  bases = { 10: base, 11: variant };
  local = memoryLocal();
  drafts = createDraftStore(memoryDrafts());
});

describe('reviewSignature', () => {
  it('sees text and the Compendium link, not who or when', () => {
    const a = tooltip(10, 'Same');
    const b = tooltip(10, 'Same');
    b.text.en = { text: 'Same', updatedAt: '2030-01-01T00:00:00Z', updatedBy: 'bob' };
    expect(reviewSignature(a)).toBe(reviewSignature(b));
    expect(reviewSignature(tooltip(10, 'Other'))).not.toBe(reviewSignature(a));
    const linked = tooltip(10, 'Same', {
      compendium: { kind: 'item', hash: 1 } as unknown as Tooltip['compendium'],
    });
    expect(reviewSignature(linked)).not.toBe(reviewSignature(a));
  });
  it('counts a change in any language', () => {
    const french = tooltip(10, 'Same');
    french.text.fr = { text: 'Salut', updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'owner' };
    expect(reviewSignature(french)).not.toBe(reviewSignature(tooltip(10, 'Same')));
  });
});

describe('changedVariants', () => {
  it('treats a new draft as a change from its base and ignores metadata-only updates', () => {
    const changed = { ...base, text: { en: { ...base.text.en!, text: 'Edited' } } };
    expect(changedVariants({}, { 10: { base, next: changed } }, () => base)).toEqual([10]);
    const touched = { ...changed, text: { en: { ...changed.text.en!, updatedBy: 'bob' } } };
    expect(
      changedVariants({ 10: { base, next: changed } }, { 10: { base, next: touched } }, () => base),
    ).toEqual([]);
  });
  it('counts a removed draft only when the text it falls back to differs', () => {
    const changed = tooltip(10, 'Edited');
    const before = { 10: { base, next: changed } };
    // Reverted to base: what a reader sees changes.
    expect(changedVariants(before, {}, () => base)).toEqual([10]);
    // Saved: the new base is the edited text; what a reader sees is the same.
    expect(changedVariants(before, {}, () => changed)).toEqual([]);
  });
});

describe('preview review store', () => {
  it('records nothing until a page registers a preview host, and nothing for loading drafts', async () => {
    const { store, stop } = setup();
    await ready();
    edit(base, 'No host yet');
    expect(store.getState().unreviewed(10)).toEqual([]);
    store.getState().registerHost(host);
    edit(base, 'With a host');
    expect(store.getState().unreviewed(10)).toEqual([10]);
    stop();
  });

  it('marks a changed variant unreviewed under its canonical item until its preview renders it', async () => {
    const { store } = setup();
    store.getState().registerHost(host);
    await ready();
    edit(variant, 'Hidden change');
    expect(store.getState().entries[11]).toEqual({ canonical: 10, dirty: 1, reviewed: 0 });
    expect(store.getState().unreviewed(10)).toEqual([11]);
    expect(store.getState().unreviewed(11)).toEqual([]);
    store.getState().acknowledge(11, 1);
    expect(store.getState().unreviewed(10)).toEqual([]);
  });

  it('keeps one obligation per canonical item: a base edit and an override edit are cleared by their own renders', async () => {
    const { store } = setup();
    store.getState().registerHost(host);
    await ready();
    edit(base, 'Edited base');
    edit(variant, 'Edited override');
    expect(store.getState().unreviewed(10).sort()).toEqual([10, 11]);
    // Seeing the Base render clears the base's edit only; the override still needs its Enhanced render.
    store.getState().acknowledge(10, 1);
    expect(store.getState().unreviewed(10)).toEqual([11]);
    // The item can be left only once nothing under it is unreviewed.
    expect(store.getState().leaveBlocked('/t/10', '/t/20')).toBe(true);
    store.getState().acknowledge(11, 1);
    expect(store.getState().unreviewed(10)).toEqual([]);
    expect(store.getState().leaveBlocked('/t/10', '/t/20')).toBe(false);
  });

  it('never lets an older render clear a newer edit, and a later edit re-arms', async () => {
    const { store } = setup();
    store.getState().registerHost(host);
    await ready();
    edit(base, 'One');
    edit(base, 'Two');
    expect(store.getState().entries[10]?.dirty).toBe(2);
    store.getState().acknowledge(10, 1);
    expect(store.getState().unreviewed(10)).toEqual([10]);
    store.getState().acknowledge(10, 2);
    expect(store.getState().unreviewed(10)).toEqual([]);
    edit(base, 'Three');
    expect(store.getState().unreviewed(10)).toEqual([10]);
    // Acknowledging a revision that never existed changes nothing.
    store.getState().acknowledge(10, 99);
    expect(store.getState().entries[10]).toEqual({ canonical: 10, dirty: 3, reviewed: 2 });
  });

  it('keeps counting a change that was typed away again, until a preview shows it', async () => {
    const { store } = setup();
    store.getState().registerHost(host);
    await ready();
    edit(base, 'Changed');
    edit(base, 'Original');
    expect(drafts.getState().drafts[10]).toBeUndefined();
    expect(store.getState().unreviewed(10)).toEqual([10]);
  });

  it('ignores edits that only touch who or when', async () => {
    const { store } = setup();
    store.getState().registerHost(host);
    await ready();
    edit(base, 'Changed');
    store.getState().acknowledge(10, 1);
    drafts.getState().updateDraft(base, (next) => ({
      ...next,
      text: { en: { ...next.text.en!, updatedBy: 'someone else' } },
    }));
    expect(store.getState().unreviewed(10)).toEqual([]);
  });

  it('counts a Compendium link change and an import into another language', async () => {
    const { store } = setup();
    store.getState().registerHost(host);
    await ready();
    drafts.getState().updateDraft(base, (next) => ({
      ...next,
      compendium: { kind: 'item', hash: 5 } as unknown as Tooltip['compendium'],
    }));
    expect(store.getState().unreviewed(10)).toEqual([10]);
    store.getState().acknowledge(10, 1);
    drafts.getState().edit(base, 'fr', 'Bonjour', 'alice');
    expect(store.getState().unreviewed(10)).toEqual([10]);
  });

  it('clears on discard, but keeps the obligation when the draft goes away by saving', async () => {
    const { store } = setup();
    store.getState().registerHost(host);
    await ready();
    edit(base, 'Edited');
    edit(variant, 'Also edited');
    drafts.getState().discard(10);
    expect(store.getState().entries[10]).toBeUndefined();
    expect(store.getState().unreviewed(10)).toEqual([11]);
    // The save pipeline makes the edited text the new base, then drops the draft.
    bases[11] = tooltip(11, 'Also edited');
    drafts.setState({ drafts: {} });
    expect(store.getState().unreviewed(10)).toEqual([11]);
  });

  it('saves unreviewed items per account, restores them after a restart and forgets reviewed ones', async () => {
    const first = setup();
    first.store.getState().registerHost(host);
    await ready();
    edit(base, 'Edited');
    edit(variant, 'Edited too');
    first.store.getState().acknowledge(11, 1);
    expect(JSON.parse(local.values.get(reviewKey('anonymous'))!)).toEqual({
      10: { canonical: 10, dirty: 1, reviewed: 0 },
    });
    first.stop();

    drafts = createDraftStore(memoryDrafts());
    const second = setup();
    await ready();
    expect(second.store.getState().unreviewed(10)).toEqual([10]);
    second.store.getState().acknowledge(10, 1);
    expect(local.values.has(reviewKey('anonymous'))).toBe(false);
  });

  it('keeps accounts apart and starts empty while drafts are not loaded', async () => {
    const { store } = setup();
    store.getState().registerHost(host);
    await ready();
    edit(base, 'Anonymous edit');
    expect(store.getState().unreviewed(10)).toEqual([10]);
    const switching = drafts.getState().activate('7');
    expect(store.getState().entries).toEqual({});
    expect(store.getState().scope).toBeNull();
    await switching;
    expect(store.getState().scope).toBe('7');
    expect(store.getState().unreviewed(10)).toEqual([]);
    await drafts.getState().activate(null);
    expect(store.getState().unreviewed(10)).toEqual([10]);
  });

  it('starts empty when the saved copy is corrupt or storage is denied', async () => {
    local.values.set(reviewKey('anonymous'), '{"10":{"canonical":"x"},"11":');
    const { store } = setup();
    await ready();
    expect(store.getState().entries).toEqual({});
    local.setItem = () => {
      throw new Error('denied');
    };
    store.getState().registerHost(host);
    edit(base, 'Edited');
    expect(store.getState().unreviewed(10)).toEqual([10]);
  });

  describe('leaving', () => {
    async function unreviewed() {
      const { store } = setup();
      store.getState().registerHost(host);
      await ready();
      edit(base, 'Edited');
      return store;
    }
    it('blocks leaving the item for another page or item, but not for itself or its variants', async () => {
      const store = await unreviewed();
      expect(store.getState().leaveBlocked('/t/10', '/t/12')).toBe(true);
      expect(store.getState().leaveBlocked('/t/10', '/review')).toBe(true);
      expect(store.getState().leaveBlocked('/t/10', '/')).toBe(true);
      expect(store.getState().leaveBlocked('/t/10', '/t/10')).toBe(false);
      expect(store.getState().leaveBlocked('/t/10', '/t/11')).toBe(false);
      expect(store.getState().leaveBlocked('/t/11', '/t/10')).toBe(false);
      expect(store.getState().leaveBlocked('/t/10', '/settings')).toBe(false);
      expect(store.getState().leaveBlocked('/review', '/t/10')).toBe(false);
      expect(store.getState().leaveBlocked('/t/12', '/review')).toBe(false);
    });
    it('is open again once the preview has rendered the change', async () => {
      const store = await unreviewed();
      store.getState().acknowledge(10, 1);
      expect(store.getState().leaveBlocked('/t/10', '/t/12')).toBe(false);
    });
    it('does not guard phones or pages with no preview host', async () => {
      const store = await unreviewed();
      desktop = false;
      expect(store.getState().leaveBlocked('/t/10', '/t/12')).toBe(false);
      desktop = true;
      store.setState({ host: null });
      expect(store.getState().leaveBlocked('/t/10', '/t/12')).toBe(false);
    });
    it('requestLeave refuses with the prompt showing, and never changes anything else', async () => {
      const store = await unreviewed();
      const epoch = store.getState().epoch;
      expect(store.getState().requestLeave('/t/10', '/t/10')).toBe(true);
      expect(store.getState().prompt).toBeNull();
      expect(store.getState().requestLeave('/t/10', '/t/12')).toBe(false);
      expect(store.getState().prompt).toBe(10);
      expect(store.getState().epoch).toBe(epoch);
      store.getState().dismissPrompt();
      expect(store.getState().prompt).toBeNull();
    });
  });

  it('lets only the callers of authorized() through the guard, and only while they run', async () => {
    const { store } = setup();
    store.getState().registerHost(host);
    await ready();
    edit(base, 'Edited');
    let inside: boolean | undefined;
    store.getState().authorized(() => {
      inside = store.getState().leaveBlocked('/t/10', '/t/12');
    });
    expect(inside).toBe(false);
    expect(store.getState().leaveBlocked('/t/10', '/t/12')).toBe(true);
    expect(() =>
      store.getState().authorized(() => {
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(store.getState().leaveBlocked('/t/10', '/t/12')).toBe(true);
  });

  it('bumps its epoch on every change and drops the host that unregisters', async () => {
    const { store } = setup();
    const stop = store.getState().registerHost(host);
    await ready();
    const before = store.getState().epoch;
    edit(base, 'Edited');
    expect(store.getState().epoch).toBe(before + 1);
    // Seeing a change does not spend an allowance; making or clearing one does.
    store.getState().acknowledge(10, 1);
    expect(store.getState().epoch).toBe(before + 1);
    store.getState().clear(10);
    expect(store.getState().epoch).toBe(before + 2);
    stop();
    expect(store.getState().host).toBeNull();
  });
});
