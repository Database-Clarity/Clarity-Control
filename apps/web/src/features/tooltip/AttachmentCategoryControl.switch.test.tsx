// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  AttachmentCategoryControl,
  demoteTooltip,
  promoteTooltip,
} from './AttachmentCategoryControl';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { useSaveState } from '../../services/save/state';
import type { Tooltip } from '@clarity/core';
import fixture from '../compendium/fixtures/triage.json';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  apiUrl: 'https://editor.test',
}));
const item = fixture.items['2467967826'];
const withText: Tooltip = {
  hash: item.hash,
  text: { en: { text: 'Original', updatedAt: '2026-11-02T00:00:00Z', updatedBy: 'a' } },
  associated: [1],
};
const empty: Tooltip = { hash: item.hash, text: {}, associated: [] };
let host: HTMLDivElement, root: Root;
const prev = [useAuthStore.getState(), useDraftStore.getState(), useSaveState.getState()];
const update = vi.fn();
const draftOf = (next: Tooltip) =>
  useDraftStore.setState({ drafts: { [next.hash]: { next } as never } });
const render = (base: Tooltip) =>
  act(async () => root.render(<AttachmentCategoryControl base={base} item={item} />));
const buttons = () => [...host.querySelectorAll('button')];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useDraftStore.setState({ drafts: {}, hydrated: true, updateDraft: update });
  useSaveState.setState({ locked: false });
  useAuthStore.setState({ user: { id: 1, login: 'e', role: 'editor' } });
  update.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAuthStore.setState(prev[0] as never);
  useDraftStore.setState(prev[1] as never);
  useSaveState.setState(prev[2] as never);
});
it('promote then demote round-trips to byte-identical tooltip JSON', () => {
  for (const base of [empty, withText]) {
    const back = demoteTooltip(promoteTooltip(base, item), base);
    expect(JSON.stringify(back)).toBe(JSON.stringify(base));
    expect('custom' in back).toBe(false);
  }
});
it('restores a pre-existing custom identity instead of deleting it', () => {
  const saved: Tooltip = { ...empty, custom: { name: 'Mine', categoryId: 'weapon-attachment' } };
  const back = demoteTooltip(promoteTooltip(saved, item), saved);
  expect(back).toEqual(saved);
});
it('shows a two-way switch with both labels', async () => {
  await render(empty);
  expect(buttons().map((b) => b.textContent)).toEqual([
    'Weapon Attachments (no tooltip)',
    'Attachment Effects (needs tooltip)',
  ]);
  expect(buttons()[0].getAttribute('aria-pressed')).toBe('true');
});
it('switches forward for editor and maintainer', async () => {
  for (const role of ['editor', 'maintainer'] as const) {
    useAuthStore.setState({ user: { id: 1, login: 'e', role } });
    await render(withText);
    await act(async () => buttons()[1].click());
    const [orig, change] = update.mock.calls.at(-1)!;
    expect(orig).toBe(withText);
    expect(change(withText).custom).toEqual({ name: item.name, categoryId: 'attachment-effect' });
  }
});
it('demotes immediately when the tooltip has no authored text', async () => {
  draftOf(promoteTooltip(empty, item));
  await render(empty);
  expect(buttons()[1].getAttribute('aria-pressed')).toBe('true');
  await act(async () => buttons()[0].click());
  const [, change] = update.mock.calls.at(-1)!;
  expect(JSON.stringify(change(promoteTooltip(empty, item)))).toBe(JSON.stringify(empty));
  expect(host.querySelector('[role=alert]')).toBeNull();
});
it('warns before demoting a tooltip with authored text, and cancel does nothing', async () => {
  draftOf(promoteTooltip(withText, item));
  await render(withText);
  await act(async () => buttons()[0].click());
  expect(update).not.toHaveBeenCalled();
  expect(host.querySelector('[role=alert]')!.textContent).toContain(
    'Text is kept but this item will no longer be listed as needing a tooltip.',
  );
  const cancel = buttons().find((b) => b.textContent === 'Cancel')!;
  await act(async () => cancel.click());
  expect(update).not.toHaveBeenCalled();
  await act(async () => buttons()[0].click());
  await act(async () =>
    buttons()
      .find((b) => b.textContent?.startsWith('Move to'))!
      .click(),
  );
  const [, change] = update.mock.calls.at(-1)!;
  expect(JSON.stringify(change(promoteTooltip(withText, item)))).toBe(JSON.stringify(withText));
});
it('disables the switch for trial/translator/anonymous', async () => {
  for (const role of ['trial', 'translator', null] as const) {
    useAuthStore.setState({
      user: role ? { id: 1, login: 'v', role, languages: ['en'] } : null,
    });
    draftOf(promoteTooltip(empty, item));
    await render(empty);
    expect(buttons().every((b) => b.disabled)).toBe(true);
  }
  expect(update).not.toHaveBeenCalled();
});
