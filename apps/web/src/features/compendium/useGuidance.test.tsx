// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { bundleUrl } from '../../services/bundle';
import { compendiumDataUrl } from '../../services/compendium';
import { useGuidance } from './useGuidance';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each([true, false])('renews after an overlapping save finishes (success: %s)', async (success) => {
  const f = guidedFixture();
  f.document.scope = `${bundleUrl}|${compendiumDataUrl}`;
  const key = `clarity-review-guidance:v1:${encodeURIComponent(f.document.scope)}`;
  localStorage.clear();
  localStorage.setItem(key, JSON.stringify({ document: f.document, revision: 'old', pending: true }));
  let complete!: (value: Response) => void;
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST') return new Promise<Response>((resolve) => { complete = resolve; });
    return Response.json({ document: f.document, revision: 'old' });
  });
  vi.stubGlobal('fetch', request);
  let result!: ReturnType<typeof useGuidance>;
  function Probe({ enabled }: { enabled: boolean }) {
    result = useGuidance(f.categories, 'renewed', f.source, enabled);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe, { enabled: false })));
    let saving!: Promise<void>;
    await act(async () => { saving = result.persistence.flush(); });
    expect(result.saving).toBe(true);
    await act(async () => root.render(createElement(Probe, { enabled: true })));
    expect(result.document.baseline).toBe(f.baseline);
    await act(async () => {
      complete(success
        ? Response.json({ document: f.document, revision: 'saved' })
        : new Response('offline', { status: 503 }));
      await saving;
    });
    expect(result.document.baseline).toBe('renewed');
    expect(result.renewalNotice).toBe('5 references carried over, 0 need re-check');
    expect(result.planningRevision).toBeGreaterThan(0);
    const backupKey = Object.keys(localStorage).find((k) => k.startsWith(`${key}:pre-renewal:`));
    expect(JSON.parse(localStorage.getItem(backupKey!)!).document).toEqual(f.document);
  } finally {
    // Dispose cannot begin another network operation during teardown.
    request.mockResolvedValue(new Response('offline', { status: 503 }));
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});
