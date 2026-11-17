// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UploadRollback } from './UploadRollback';
import { TranslatorsButton } from '../translations/TranslatorsPanel';
import * as managers from '../../services/managers';

// States the browser render QA (test/managers-browser.mjs) does not reach: nothing to roll back,
// failed checks and applies, and an empty or failed translators list.
vi.mock('../../services/managers', () => ({
  getRollbackPlan: vi.fn(),
  applyRollback: vi.fn(),
  getTranslators: vi.fn(),
  addTranslator: vi.fn(),
  removeTranslator: vi.fn(),
}));
const mocked = vi.mocked(managers);
let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  vi.resetAllMocks();
});
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((entry) => entry.textContent === label);
// A browser focuses a pressed button; jsdom's click() does not.
const press = (target: HTMLButtonElement) => {
  target.focus();
  target.click();
};
const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
const commit = 'a'.repeat(40);

it('says when a later save changed everything, writes nothing, and closes to the trigger', async () => {
  mocked.getRollbackPlan.mockResolvedValue({
    upload: commit,
    lang: 'fr',
    reverted: [],
    skipped: [{ hash: 10, reason: 'changed-later' }],
  });
  await act(async () => root!.render(<UploadRollback commit={commit} lang="fr" />));
  await act(async () => press(button('Roll back this upload (French)')!));
  await settle();
  expect(host.textContent).toContain('Nothing to roll back');
  expect(host.textContent).toContain('Skips 1 changed by a later save');
  expect(button('Roll back 0')).toBeUndefined();
  expect(document.activeElement).toBe(button('Close'));
  await act(async () => button('Close')!.click());
  expect(document.activeElement).toBe(button('Roll back this upload (French)'));
  expect(mocked.applyRollback).not.toHaveBeenCalled();
});

it('shows a failed check and returns focus to the trigger', async () => {
  mocked.getRollbackPlan.mockRejectedValue(new Error('Only uploads can be rolled back'));
  await act(async () => root!.render(<UploadRollback commit={commit} lang="fr" />));
  await act(async () => press(button('Roll back this upload (French)')!));
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Only uploads can be rolled back');
  expect(document.activeElement).toBe(button('Roll back this upload (French)'));
});

it('keeps the confirm open with the error when the apply fails', async () => {
  mocked.getRollbackPlan.mockResolvedValue({
    upload: commit,
    lang: 'fr',
    reverted: [10],
    skipped: [],
  });
  mocked.applyRollback.mockRejectedValue(new Error('Data branch kept moving; reload and retry'));
  const done = vi.fn();
  await act(async () => root!.render(<UploadRollback commit={commit} lang="fr" onDone={done} />));
  await act(async () => press(button('Roll back this upload (French)')!));
  await settle();
  await act(async () => button('Roll back 1')!.click());
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('kept moving');
  expect(button('Roll back 1')).toBeDefined();
  expect(done).not.toHaveBeenCalled();
});

it('translators: an empty list, and a failed load with Retry', async () => {
  mocked.getTranslators.mockRejectedValueOnce(
    new Error('Only fr translation managers can do this'),
  );
  mocked.getTranslators.mockResolvedValueOnce([]);
  await act(async () => root!.render(<TranslatorsButton lang="fr" selfId={5} />));
  await act(async () => button('Translators')!.click());
  await settle();
  const surface = () => document.body.textContent ?? '';
  expect(surface()).toContain('Only fr translation managers can do this');
  await act(async () => button('Retry')!.click());
  await settle();
  expect(surface()).toContain('No translators yet.');
  expect(mocked.getTranslators).toHaveBeenCalledTimes(2);
});
