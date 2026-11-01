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

async function mount() {
  const cache = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
  });
  const f = guidedFixture();
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
