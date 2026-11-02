// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AttachmentCategoryControl, setTooltipCategory } from './AttachmentCategoryControl';
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
const nativeEffect = fixture.items['689005463' as keyof typeof fixture.items];
const promoteTooltip = (t: Tooltip, i: { name: string }) =>
  setTooltipCategory(t, i, 'attachment-effect', 'weapon-attachment');
const demoteTooltip = (t: Tooltip) =>
  setTooltipCategory(t, item, 'weapon-attachment', 'weapon-attachment');
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
it('promote then demote round-trips to byte-identical tooltip JSON, also after saving', () => {
  for (const base of [empty, withText]) {
    const promoted = promoteTooltip(base, item);
    const back = demoteTooltip(promoted);
    expect(JSON.stringify(back)).toBe(JSON.stringify(base));
    expect('custom' in back).toBe(false);
    // The promoted state is saved (becomes the new base); a later demotion must still be exact.
    const saved: Tooltip = JSON.parse(JSON.stringify(promoted));
    expect(JSON.stringify(demoteTooltip(saved))).toBe(JSON.stringify(base));
  }
});
it.each([
  { name: item.name, categoryId: 'weapon-attachment' },
  { name: item.name, categoryId: 'weapon-perk' },
  { name: 'Mine', categoryId: 'weapon-perk' },
  { name: 'Mine', categoryId: 'weapon-attachment' },
  { name: 'Mine', categoryId: 'attachment-effect' },
])('disables independent custom identity %j before and after save/reload', async (custom) => {
  const original: Tooltip = { ...withText, custom };
  const bytes = JSON.stringify(original);
  for (const base of [original, JSON.parse(bytes) as Tooltip]) {
    await render(base);
    expect(buttons().every((button) => button.disabled)).toBe(true);
    expect(host.textContent).toContain(
      'This item has its own custom identity; change its category in the identity editor.',
    );
    for (const button of buttons()) await act(async () => button.click());
    expect(update).not.toHaveBeenCalled();
    expect(host.querySelector('[role=alert]')).toBeNull();
    // Guard the updater too, including when an identity is edited after rendering.
    expect(promoteTooltip(base, item)).toBe(base);
    expect(demoteTooltip(base)).toBe(base);
    expect(JSON.stringify(base)).toBe(bytes);
  }
});
it('disables the switch when an independent identity is introduced in a draft', async () => {
  const next = { ...empty, custom: { name: item.name, categoryId: 'weapon-perk' } };
  draftOf(next);
  await render(empty);
  expect(buttons().every((button) => button.disabled)).toBe(true);
  expect(host.textContent).toContain('This item has its own custom identity');
});
it('accepts a pre-existing identity identical to a saved switch override', async () => {
  const saved: Tooltip = JSON.parse(
    JSON.stringify({
      ...empty,
      custom: { name: item.name, categoryId: 'attachment-effect' },
    }),
  );
  await render(saved);
  expect(buttons().every((button) => !button.disabled)).toBe(true);
  await act(async () => buttons()[0].click());
  const [, change] = update.mock.calls.at(-1)!;
  expect(JSON.stringify(change(saved))).toBe(JSON.stringify(empty));
});
it('switches a native Attachment Effect to Weapon Attachments and back, byte-identical', async () => {
  const native = { ...empty, hash: nativeEffect.hash };
  for (const role of ['editor', 'maintainer'] as const) {
    useAuthStore.setState({ user: { id: 1, login: 'e', role } });
    await act(async () =>
      root.render(<AttachmentCategoryControl base={native} item={nativeEffect as never} />),
    );
    expect(buttons()[1].getAttribute('aria-pressed')).toBe('true');
    expect(buttons().every((b) => !b.disabled)).toBe(true);
    await act(async () => buttons()[0].click());
    const [, change] = update.mock.calls.at(-1)!;
    const overridden = change(native);
    expect(overridden.custom).toEqual({ name: nativeEffect.name, categoryId: 'weapon-attachment' });
    const saved = JSON.parse(JSON.stringify(overridden));
    const back = setTooltipCategory(saved, nativeEffect, 'attachment-effect', 'attachment-effect');
    expect(JSON.stringify(back)).toBe(JSON.stringify(native));
  }
});
it('classifies a native effect with the weapon-attachment override as an excluded attachment', async () => {
  const { classifyItem } = await import('../compendium/itemClassification');
  const overridden = setTooltipCategory(
    empty,
    nativeEffect,
    'weapon-attachment',
    'attachment-effect',
  );
  expect(classifyItem(nativeEffect as never, overridden)).toMatchObject({
    categoryId: 'weapon-attachment',
    excluded: true,
  });
  expect(classifyItem(nativeEffect as never, empty)?.categoryId).toBe('attachment-effect');
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
