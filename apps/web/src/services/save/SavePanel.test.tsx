import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { SavePanel } from './SavePanel';
import { useSaveState } from './state';
import { useDraftStore } from '../../stores/drafts';
import { useAuthStore } from '../../stores/auth';

const mockApi = vi.hoisted(() => ({ apiUrl: 'https://api.example' as string | undefined }));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    get apiUrl() {
      return mockApi.apiUrl;
    },
  };
});
vi.mock('./state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state')>();
  return {
    ...actual,
    useSaveState: Object.assign(
      (selector: (state: ReturnType<typeof actual.useSaveState.getState>) => unknown) =>
        selector(actual.useSaveState.getState()),
      actual.useSaveState,
    ),
  };
});
vi.mock('../../ui/Dialog', () => ({
  Dialog: ({ title }: { title: string }) => createElement('div', { 'data-dialog': title }),
}));
vi.mock('../../stores/drafts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/drafts')>();
  return {
    ...actual,
    useDraftStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useDraftStore.getState>) => unknown) =>
        selector(actual.useDraftStore.getState()),
      actual.useDraftStore,
    ),
  };
});
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return {
    ...actual,
    useAuthStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useAuthStore.getState>) => unknown) =>
        selector(actual.useAuthStore.getState()),
      actual.useAuthStore,
    ),
  };
});

function tooltip(hash: number, text: string): Tooltip {
  return {
    hash,
    text: { en: { text, updatedAt: '2026-10-27T00:00:00Z', updatedBy: 'owner' } },
    associated: [],
  };
}
const draft = { base: tooltip(1, 'a'), next: tooltip(1, 'b') };

function render() {
  return renderToStaticMarkup(createElement(SavePanel, { className: 'dock' }));
}
function buttonDisabled(html: string) {
  return /<button[^>]*disabled/.test(html);
}

describe('SavePanel dock markup', () => {
  const originalDrafts = useDraftStore.getState();
  const originalAuth = useAuthStore.getState();
  beforeEach(() => {
    mockApi.apiUrl = 'https://api.example';
    useSaveState.setState({ locked: false, review: null });
    useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'editor' } });
    useDraftStore.setState({ drafts: { 1: draft } });
  });
  afterEach(() => {
    useDraftStore.setState(originalDrafts);
    useAuthStore.setState(originalAuth);
    useSaveState.setState({ locked: false, review: null });
  });

  it('is idle with zero drafts, no notice and no review', () => {
    useDraftStore.setState({ drafts: {} });
    const html = render();
    expect(html).toContain('data-idle="true"');
    expect(html).toContain('class="dock"');
    expect(html).not.toContain('data-dialog');
  });

  it('is active and shows the count with at least one draft', () => {
    const html = render();
    expect(html).toContain('data-idle="false"');
    expect(html).toContain('1 local draft(s)');
    expect(buttonDisabled(html)).toBe(false);
  });

  it('stays active and mounts the review dialog while a review is open', () => {
    useDraftStore.setState({ drafts: {} });
    useSaveState.setState({ locked: true, review: { changes: [], submitted: {} } });
    const html = render();
    expect(html).toContain('data-idle="false"');
    expect(html).toContain('data-dialog="Review save"');
    expect(buttonDisabled(html)).toBe(true);
  });

  it('disables the button without an API URL', () => {
    mockApi.apiUrl = undefined;
    expect(buttonDisabled(render())).toBe(true);
  });

  it('disables the button for a user without a role', () => {
    useAuthStore.setState({ user: { id: 2, login: 'bob', role: null } });
    expect(buttonDisabled(render())).toBe(true);
  });

  it('disables the button with zero drafts', () => {
    useDraftStore.setState({ drafts: {} });
    expect(buttonDisabled(render())).toBe(true);
  });
});
