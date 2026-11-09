// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tooltip } from '@clarity/core';
import { SaveController } from './SavePanel';
import { useSaveState } from './state';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { editorData, english } from './fixtures.testSupport';

// The real validation pipeline: only the network and chrome are replaced.
const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  apiUrl: 'https://api.example',
  save: mocks.save,
}));
vi.mock('../session', () => ({ sessionToken: () => 'token-a' }));
vi.mock('./SaveSummary', () => ({ SaveSummary: () => null }));
vi.mock('../../ui/Dialog', () => ({
  Dialog: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) =>
    createElement('div', null, children, footer),
}));

const alice = { id: 1, login: 'alice', role: 'editor' as const };
const unwritten: Tooltip = { hash: 123, text: {}, associated: [] };
let root: Root;
let host: HTMLDivElement;

const saveButton = () =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save changes')!;
async function open(base: Tooltip, next: Tooltip) {
  await act(async () =>
    useSaveState.setState({
      locked: true,
      review: {
        changes: [{ hash: 123, base, next }],
        submitted: { 123: { base, next } },
      },
    }),
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.save.mockReset();
  useAuthStore.setState({ user: alice, token: 'token-a', loading: false });
  useDataStore.setState({ data: editorData() });
  useDraftStore.setState({
    drafts: {},
    hydrated: true,
    error: null,
    generation: 3,
    flush: async () => {},
  });
  useSaveState.setState({ locked: false, review: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useSaveState.setState({ locked: false, review: null });
});

describe('save review validates only the text the change edits', () => {
  const render = () => act(async () => root.render(createElement(SaveController)));

  it('does not block a link-only change on a tooltip whose English is empty', async () => {
    await render();
    await open(unwritten, { ...unwritten, associated: [30] });
    expect(saveButton().disabled).toBe(false);
    expect(host.textContent).not.toContain('must not be empty');
  });

  it('blocks editing English to an error', async () => {
    const base: Tooltip = { ...unwritten, text: { en: english } };
    await render();
    await open(base, { ...base, text: { en: { ...english, text: 'import main from 999' } } });
    expect(saveButton().disabled).toBe(true);
  });
});
