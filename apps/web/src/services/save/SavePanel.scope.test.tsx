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
const mocks = vi.hoisted(() => ({ save: vi.fn(), validate: vi.fn() }));
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
  mocks.validate.mockReset();
  mocks.validate.mockImplementation(async (changes, data) => {
    const { validateChanges } = await import('./validation');
    return validateChanges(changes, data);
  });
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

vi.mock('./validationWorker', () => ({ requestSaveValidation: mocks.validate }));

it('blocks while pending, discards stale completions, and fails closed on errors', async () => {
  const completions: ((issues: unknown[]) => void)[] = [];
  mocks.validate.mockImplementation(() => new Promise((resolve) => completions.push(resolve)));
  await act(async () => root.render(createElement(SaveController)));
  await open(unwritten, { ...unwritten, associated: [30] });
  expect(host.textContent).toContain('Validating save...');
  const button = host.querySelector('button')!;
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(mocks.save).not.toHaveBeenCalled();
  await act(async () => useDataStore.setState({ data: editorData() }));
  await act(async () => completions[0]([]));
  expect(host.textContent).toContain('Validating save...');
  await act(async () =>
    completions[1]([
      { severity: 'error', hash: 123, lang: 'en', message: 'blocked', from: 0, to: 0 },
    ]),
  );
  expect(saveButton().disabled).toBe(true);
  // Replacing the review snapshot immediately invalidates the old result.
  mocks.validate.mockRejectedValue(new Error('Worker unavailable'));
  await open(unwritten, { ...unwritten, associated: [31] });
  expect(saveButton().disabled).toBe(true);
  expect(host.textContent).toContain('Worker unavailable');
});
it('ignores a completion after cancel and validates a later review', async () => {
  let complete!: (issues: unknown[]) => void;
  mocks.validate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => root.render(createElement(SaveController)));
  await open(unwritten, { ...unwritten, associated: [30] });
  const cancel = [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith('Cancel'),
  )!;
  await act(async () => cancel.click());
  await act(async () => complete([]));
  expect(host.textContent).not.toContain('Save changes');
  await open(unwritten, { ...unwritten, associated: [31] });
  expect(saveButton().disabled).toBe(false);
});
