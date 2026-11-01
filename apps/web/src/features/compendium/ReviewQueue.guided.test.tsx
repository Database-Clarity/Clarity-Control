// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { ReviewQueue } from './MatchReviewPage';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';
import { useSaveState } from '../../services/save/state';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { guidedDecisions, guidedRevision } from './guidedDecisions';
import type { CategoryReview } from './CategoryReview';
import { loadManifestFacts } from './manifestFacts';
import { reviewCategories } from './reviewCategories';
import { emptyProgress, sourceFingerprint } from './reviewProgress';
import { reviewQueue } from './reviewQueue';
import { proposalFor } from './rapidReview';
import { sampleReference } from './sampleReferences';

vi.mock('../../services/api', () => ({ apiUrl: 'https://synthetic.invalid' }));
vi.mock('../../services/draftStorage', () => ({
  draftStorage: { read: async () => ({}), write: async () => {} },
}));
const captured = vi.hoisted(() => ({ props: undefined as unknown, proposals: new Map() }));
vi.mock('./useProposals', () => ({
  useProposals: () => ({ proposals: captured.proposals, loading: false }),
}));
vi.mock('./CategoryReview', async (original) => {
  const actual = await original<typeof import('./CategoryReview')>();
  return {
    CategoryReview: (props: Parameters<typeof CategoryReview>[0]) => {
      captured.props = props;
      return createElement(actual.CategoryReview, props);
    },
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.unstubAllGlobals();
});

async function mount(scope?: 'ghost' | 'mixed') {
  const cache = new Map<string, string>();
  let backupFailure = false;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (backupFailure && key.includes(':pre-renewal:')) throw new Error('quota');
      cache.set(key, value);
    },
  });
  const f = guidedFixture();
  if (scope) {
    const categoryId = scope === 'ghost' ? 'ghost-mod' : 'weapon-perk';
    for (const item of Object.values(f.editor.items)) item.categoryId = categoryId;
    if (scope === 'mixed') {
      const inventory = loadManifestFacts().items['5699512'].inventory!;
      f.editor.items[5699512] = {
        hash: 5699512,
        name: inventory.displayName!,
        categoryId,
        icon: '',
        inGameDescription: inventory.description!,
      };
    }
    const entries = reviewQueue(
      f.editor,
      f.source,
      {},
      emptyProgress(),
      sourceFingerprint(f.source.tabs),
    );
    f.proposals = new Map(
      entries.map((entry) => [entry.hash, proposalFor(entry.base, f.editor, f.source)]),
    );
    f.categories = reviewCategories(entries, f.editor, f.proposals, false);
    const category = f.categories[0];
    const original = Object.values(f.document.categories)[0];
    f.document.categories = {
      [category.id]: {
        ...original,
        id: category.id,
        name: category.name,
        rule: category.rule,
        count: entries.length,
        hashes: entries.map((entry) => entry.hash),
        references: Object.fromEntries(
          Object.values(original.references!).map((reference) => [
            reference.hash,
            sampleReference(
              category.entries.find((entry) => entry.hash === reference.hash)!,
              category.id,
              f.baseline,
              reference.note,
              reference.decision,
              reference.link ? f.proposals.get(reference.hash)?.match : undefined,
              f.source,
            ),
          ]),
        ),
      },
    };
  }
  f.document.scope = `${bundleUrl}|${compendiumDataUrl}`;
  captured.proposals = f.proposals;
  let disk = structuredClone(f.document);
  let conflict = false;
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST') {
      if (conflict) return new Response('Conflict', { status: 409 });
      disk = JSON.parse(String(init.body)).document;
    }
    return Response.json({ document: disk, revision: 'synthetic-revision' });
  });
  vi.stubGlobal('fetch', request);
  useAuthStore.setState({ user: { id: 1, login: 'owner', role: 'editor' } });
  useSaveState.setState({ locked: false });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(ReviewQueue, {
          editor: f.editor,
          source: f.source,
          storageKey: 'synthetic-review',
        }),
      ),
    ),
  );
  const props = () => captured.props as Parameters<typeof CategoryReview>[0];
  const button = (text: string, within: ParentNode = host) =>
    [...within.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text))!;
  const click = async (text: string, within: ParentNode = host) => {
    await act(async () => button(text, within).click());
  };
  const frozen = () => {
    const p = props();
    const group = guidedDecisions(
      p.guidance.proposalInput!,
      p.categories,
      p.proposals,
      p.source,
      f.baseline,
      f.document.scope,
    )[0];
    return () =>
      p.onAccept!(
        p.categories[0],
        group.entries.filter((e) => e.action === 'link' && e.confidence === 'high'),
        guidedRevision([group]),
      );
  };
  return {
    ...f,
    host,
    props,
    button,
    click,
    frozen,
    request,
    failBackups: () => {
      backupFailure = true;
    },
    conflict: () => {
      conflict = true;
    },
    close: async () => {
      await act(async () => root.unmount());
      await useDraftStore.getState().flush();
    },
  };
}

it.each([false, true])(
  'rejects old owner links before confirmation, including after disk save=%s',
  async (save) => {
    const f = await mount();
    try {
      await f.click('Preview all high');
      const oldHandler = f.frozen();
      const sample = f.host.querySelector('[aria-label="Resolve sample Sample 100"]')!;
      await f.click('No equivalent', sample);
      if (save) await act(async () => f.props().guidance.persistence.flush());
      expect(f.button('Accept all high').disabled).toBe(true);
      await act(async () => oldHandler());
      expect(useDraftStore.getState().drafts).toEqual({});
      await f.click('Preview all high');
      await f.click('Accept all high');
      expect(Object.keys(useDraftStore.getState().drafts).sort()).toEqual(['101', '102']);
      expect(useDraftStore.getState().drafts[100]).toBeUndefined();
    } finally {
      await f.close();
    }
  },
);

it.each(['ghost', 'mixed'] as const)(
  'retains %s exclusions and Restore when stale-guidance renewal cannot back up',
  async (scope) => {
    const f = await mount(scope);
    try {
      const original = structuredClone(f.props().guidance.document);
      f.failBackups();
      await act(async () => {
        f.props().guidance.persistence.importBackup({
          ...original,
          baseline: 'stale-baseline',
        });
      });
      const p = f.props();
      expect(p.guidance.document.baseline).toBe('stale-baseline');
      expect(p.guidance.document.categories).toEqual(original.categories);
      expect(p.guidance.localError).toContain('renewal backup failed');
      expect(f.host.textContent).toContain(`Not needed (${scope === 'ghost' ? 6 : 1})`);
      expect(f.button('Restore to scope')).toBeTruthy();
      const group = guidedDecisions(
        p.guidance.proposalInput!,
        p.categories,
        p.proposals,
        f.source,
        f.baseline,
        f.document.scope,
      )[0];
      expect(group.high).toBe(0);
      expect(group.medium).toBe(0);
      expect(group.outOfScope).toBe(scope === 'ghost' ? 6 : 1);
      expect(group.samples).not.toContain(scope === 'ghost' ? 100 : 5699512);
      await act(async () => p.onRestore!(scope === 'ghost' ? 100 : 5699512));
      expect(f.host.textContent).toContain(`Not needed (${scope === 'ghost' ? 5 : 0})`);
      expect(useDraftStore.getState().drafts).toEqual({});
    } finally {
      await f.close();
    }
  },
);

it('accepts frozen links and undo restores only metadata while retaining later text edits', async () => {
  const f = await mount();
  try {
    await f.click('Preview all high');
    await f.click('Accept all high');
    expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['100', '101', '102']);
    const base = useDraftStore.getState().drafts[100].base;
    await act(async () =>
      useDraftStore.getState().edit(base, 'en', 'Owner text after acceptance', 'owner'),
    );
    await f.click('Undo last');
    const drafts = useDraftStore.getState().drafts;
    expect(Object.keys(drafts)).toEqual(['100']);
    expect(drafts[100].next.compendium).toBeUndefined();
    expect(drafts[100].next.text.en?.text).toBe('Owner text after acceptance');
    expect(drafts[100].next.associated).toEqual(base.associated);
    expect(f.request.mock.calls.every(([url]) => String(url).endsWith('__review-guidance'))).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

it.each(['comment', 'reload', 'conflict'] as const)(
  'invalidates frozen preview and captured handler on %s',
  async (kind) => {
    const f = await mount();
    try {
      await f.click('Preview all high');
      const oldHandler = f.frozen();
      const persistence = f.props().guidance.persistence;
      await act(async () => {
        if (kind === 'comment')
          persistence.comment(f.categories[0].id, 'Needs owner interpretation');
        if (kind === 'reload') await persistence.reloadDisk();
        if (kind === 'conflict') {
          f.conflict();
          persistence.synchronize([], f.baseline);
          await persistence.flush();
        }
        // Invoke before React can refresh the render's captured guidance state.
        oldHandler();
      });
      expect(f.button('Accept all high').disabled).toBe(true);
      expect(useDraftStore.getState().drafts).toEqual({});
    } finally {
      await f.close();
    }
  },
);

it('keeps an entirely ghost category out of owner samples, counts and browse actions', async () => {
  const f = await mount('ghost');
  try {
    expect(f.host.textContent).toContain('0/0 samples resolved');
    expect(f.host.textContent).toContain('Browse / category definition (0 entries)');
    expect(f.host.textContent).toContain('Not needed (6)');
    expect(f.host.querySelector('[aria-label="Representative samples"]')?.children).toHaveLength(0);
    expect(f.host.querySelector('[aria-label^="Resolve sample"]')).toBeNull();
    expect(f.host.textContent).not.toContain('Validated proposals:');
    const p = f.props();
    expect(p.categories[0].entries).toHaveLength(6);
    expect(Object.values(p.guidance.document.categories)[0].references).toHaveProperty('100');
  } finally {
    await f.close();
  }
});

it('removes real stat-only samples from mixed category owner surfaces without losing membership', async () => {
  const f = await mount('mixed');
  try {
    expect(f.host.textContent).toContain('Browse / category definition (6 entries)');
    expect(f.host.textContent).toContain('Not needed (1)');
    expect(
      f.host.querySelector('[aria-label="Representative samples"]')?.textContent,
    ).not.toContain('Horizon Ironsights');
    expect(f.host.querySelector('[aria-label^="Resolve sample Horizon"]')).toBeNull();
    expect(f.host.textContent).not.toContain('No resolver candidate: 1');
    expect(f.props().categories[0].entries).toHaveLength(7);
  } finally {
    await f.close();
  }
});

it.each([false, true])(
  'invalidates captured acceptance when real excluded scope is restored, after render=%s',
  async (afterRender) => {
    const f = await mount('mixed');
    try {
      await f.click('Preview all high');
      const oldHandler = f.frozen();
      const restore = f.props().onRestore!;
      await act(async () => {
        restore(5699512);
        if (!afterRender) oldHandler();
      });
      if (afterRender) await act(async () => oldHandler());
      expect(useDraftStore.getState().drafts).toEqual({});
      expect(f.host.textContent).toContain('Review scope changed');
      expect(f.button('Accept all high').disabled).toBe(true);
      expect(f.host.textContent).toContain('Not needed (0)');
      expect(f.host.textContent).toContain('Browse / category definition (7 entries)');
      await f.click('Preview all high');
      await f.click('Accept all high');
      expect(Object.keys(useDraftStore.getState().drafts)).toEqual(['100', '101', '102']);
    } finally {
      await f.close();
    }
  },
);
