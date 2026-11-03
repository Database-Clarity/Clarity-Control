import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { SaveController, SavePanel } from './SavePanel';
import { useSaveNotice } from './notice';
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
vi.mock('./notice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notice')>();
  return {
    ...actual,
    useSaveNotice: Object.assign(
      (selector: (state: ReturnType<typeof actual.useSaveNotice.getState>) => unknown) =>
        selector(actual.useSaveNotice.getState()),
      actual.useSaveNotice,
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

describe('SavePanel drafts summary', () => {
  const originalDrafts = useDraftStore.getState();
  const originalAuth = useAuthStore.getState();
  beforeEach(() => {
    mockApi.apiUrl = 'https://api.example';
    useSaveState.setState({ locked: false, review: null });
    useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'editor' } });
    useDraftStore.setState({ drafts: { 1: draft } });
    useSaveNotice.setState({ notice: null });
  });
  afterEach(() => {
    useDraftStore.setState(originalDrafts);
    useAuthStore.setState(originalAuth);
    useSaveState.setState({ locked: false, review: null });
  });

  it('shows the count and the review action', () => {
    useDraftStore.setState({ drafts: {} });
    const empty = render();
    expect(empty).toContain('0 local draft(s)');
    expect(empty).toContain('class="dock"');
    expect(empty).not.toContain('data-dialog');
    useDraftStore.setState({ drafts: { 1: draft } });
    const html = render();
    expect(html).toContain('1 local draft(s)');
    expect(buttonDisabled(html)).toBe(false);
  });

  it('keeps the last save result in the shell store, not in the popover', () => {
    useSaveNotice.setState({ notice: 'Saved 1 tooltip(s) in abc12345.' });
    expect(render()).toContain('Saved 1 tooltip(s) in abc12345.');
  });

  it('disables the review button while a review is open; the controller owns the dialog', () => {
    useDraftStore.setState({ drafts: {} });
    useSaveState.setState({ locked: true, review: { changes: [], submitted: {} } });
    expect(buttonDisabled(render())).toBe(true);
    // The dialog is the always-mounted controller's, so closing the popover can never drop it.
    expect(render()).not.toContain('data-dialog');
    expect(renderToStaticMarkup(createElement(SaveController))).toContain(
      'data-dialog="Review save"',
    );
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
