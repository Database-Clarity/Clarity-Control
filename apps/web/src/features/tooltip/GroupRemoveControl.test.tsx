// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyAliasGroups, type AliasGroups, type Tooltip } from '@clarity/core';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { applySavedOverlay, clearSavedOverlay } from '../../stores/savedOverlay';
import { getAliasGroupsHead, removeGroupMember } from '../../services/aliasGroups';
import { GroupRemoveControl } from './GroupRemoveControl';

vi.mock('../../services/api', () => ({ apiUrl: 'https://api.test' }));
vi.mock('../../services/aliasGroups', () => ({
  getAliasGroupsHead: vi.fn(),
  removeGroupMember: vi.fn(),
}));
vi.mock('../../ui/interaction', () => ({ useWorkspaceShortcutOwner: vi.fn() }));
let root: Root;
let host: HTMLDivElement;
const head = 'a'.repeat(40);
const item = (hash: number, sandboxPerkHashes?: number[]) => ({
  hash,
  name: 'Frost Renewal',
  categoryId: 'armor-mod-seasonal',
  inGameDescription: 'Same',
  ...(sandboxPerkHashes ? { sandboxPerkHashes } : {}),
});
const groups: AliasGroups = {
  ...emptyAliasGroups(),
  groups: {
    42: {
      members: [42, 43],
      kind: 'S',
      basis: { name: 'Frost Renewal', categoryId: 'armor-mod-seasonal' },
      by: { id: '1', login: 'alice' },
      at: '2026-11-01T00:00:00Z',
    },
  },
};
const stale = '2026-10-01T00:00:00Z';
const text: Tooltip = {
  hash: 42,
  text: {
    en: { text: 'Group text', updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'alice' },
    de: {
      text: 'Gruppe',
      updatedAt: '2026-11-02T00:00:00Z',
      updatedBy: 'bob',
      sourceUpdatedAt: '2026-11-01T00:00:00Z',
    },
  },
  associated: [],
};
function seed(conflicts: Record<string, number[]> = {}) {
  useDataStore.setState({
    status: 'ready',
    data: {
      items: { 42: item(42, [900]), 43: item(43, [901]) },
      aliases: { 43: { to: 42, kind: 'name' }, 901: { to: 42, kind: 'sandbox' } },
      generatorAliases: { 900: { to: 42, kind: 'sandbox' }, 901: { to: 43, kind: 'sandbox' } },
      sandboxConflicts: conflicts,
      categories: [],
      bundle: {
        sourceCommit: 'old',
        generatedAt: stale,
        tooltips: { 42: text },
        pushed: { 42: 'a', 43: 'b' },
        aliasGroups: groups,
      },
    } as unknown as EditorData,
  });
}
const stored: Tooltip = {
  ...text,
  hash: 43,
  text: { ...text.text, en: { ...text.text.en!, text: 'Saved elsewhere' } },
};
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent === name,
  )!;
const render = (hash = 43) =>
  act(async () => root.render(<GroupRemoveControl hash={hash} name="Frost Renewal" />));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'maintainer' }, token: 'token' });
  seed();
  vi.mocked(getAliasGroupsHead).mockResolvedValue(head);
  vi.mocked(removeGroupMember).mockResolvedValue({
    head: 'b'.repeat(40),
    config: {
      ...groups,
      groups: {},
      removed: {
        43: { canonical: 42, by: { id: '1', login: 'alice' }, at: '2026-11-23T00:00:00Z' },
      },
    },
    issues: [],
    affectedCanonicals: [42, 43],
    // The server's copy, newer than this tab's canonical.
    tooltip: stored,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearSavedOverlay();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('removes a member after an in-place confirm and shows it as its own entry with the copied text', async () => {
  await render();
  await act(async () => button('Remove from group').click());
  expect(document.body.textContent).toContain('starts with a copy of the group');
  await act(async () => button('Remove').click());
  expect(removeGroupMember).toHaveBeenCalledWith(head, 42, 43);
  const data = useDataStore.getState().data!;
  expect(data.bundle.aliasGroups?.groups).toEqual({});
  expect(data.bundle.tooltips[43]).toEqual(stored);
  expect(data.bundle.pushed).toEqual({ 42: 'a' });
  // Its own sandbox perk now opens it, not the former group.
  expect(data.aliases[43]).toBeUndefined();
  expect(data.aliases[901]).toEqual({ to: 43, kind: 'sandbox' });
  // An in-app reload of an older bundle keeps both, until a bundle lists the removal.
  const old = {
    sourceCommit: 'old',
    generatedAt: stale,
    tooltips: { 42: text },
    aliasGroups: groups,
  };
  const kept = applySavedOverlay(old as never);
  expect([kept.aliasGroups?.groups, kept.tooltips[43]]).toEqual([{}, stored]);
  const caught = {
    ...old,
    tooltips: { 42: text, 43: stored },
    aliasGroups: data.bundle.aliasGroups,
  };
  expect(applySavedOverlay(caught as never)).toBe(caught);
});

it('offers nothing for the main entry, editors, or translators', async () => {
  await render(42);
  expect(host.textContent).toBe('');
  for (const role of ['editor', 'translator'] as const) {
    useAuthStore.setState({ user: { id: 2, login: 'bob', role } });
    await render();
    expect(host.textContent).toBe('');
  }
  expect(getAliasGroupsHead).not.toHaveBeenCalled();
});

it('says a refusal plainly, and asks to retry only when that can help', async () => {
  const refuse = async (error: Error) => {
    vi.mocked(removeGroupMember).mockRejectedValueOnce(error);
    await act(async () => button('Remove from group').click());
    await act(async () => button('Remove').click());
    const shown = document.querySelector('[role="alert"]')?.textContent;
    await act(async () => button('Cancel').click());
    return shown;
  };
  await render();
  expect(
    await refuse(Object.assign(new Error('Remove the enhanced one first'), { refused: true })),
  ).toBe('Remove the enhanced one first.');
  expect(await refuse(new Error('Failed to fetch'))).toBe(
    'Failed to fetch. Close and reopen to reload, then try again.',
  );
});

it('shows the refusal instead of the action for a shared sandbox perk', async () => {
  seed({ 901: [42, 43] });
  await render();
  expect(host.textContent).toBe('Stays grouped: shared sandbox perk');
  expect(host.querySelector('span')?.title).toBe(
    'Sandbox perk 901 is shared with another inventory item',
  );
});
