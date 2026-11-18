// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  localizableBuiltIns,
  validateSnippetTranslation,
} from '../../../../../packages/core/src/localizedSnippets';
import * as api from '../../services/snippets';
import { SnippetTranslations } from './SnippetTranslations';

vi.mock('../../services/snippets', async (original) => ({
  ...(await original<typeof api>()),
  getTeamSnippets: vi.fn(),
  getSnippetTranslations: vi.fn(),
  getLocalizedSnippets: vi.fn(),
  saveSnippetTranslation: vi.fn(),
}));
vi.mock('../editor/suggest/custom', () => ({ invalidateSnippetCatalogue: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
const source = localizableBuiltIns[0]!;
const base = {
  label: 'Notiz',
  keywords: 'Notiz',
  template: source.template,
  enHash: '0'.repeat(64),
};
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.mocked(api.getTeamSnippets).mockResolvedValue({
    team: { v: 1, snippets: [] },
  } as Awaited<ReturnType<typeof api.getTeamSnippets>>);
  vi.mocked(api.getSnippetTranslations).mockResolvedValue({ translations: { [source.id]: base } });
  vi.mocked(api.getLocalizedSnippets).mockResolvedValue({
    snippets: [],
    outdated: [source.id],
    canManage: true,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function mount() {
  await act(async () => root.render(<SnippetTranslations lang="de" onClose={() => {}} />));
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function text(value: string) {
  const area = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('orders outdated entries first without changing catalogue order within each status', async () => {
  const last = localizableBuiltIns.at(-1)!;
  vi.mocked(api.getLocalizedSnippets).mockResolvedValue({
    snippets: [],
    outdated: [last.id],
    canManage: true,
  });
  await mount();
  expect([...host.querySelectorAll('[data-edit]')].map((b) => b.getAttribute('data-edit'))).toEqual(
    [last.id, ...localizableBuiltIns.filter((s) => s.id !== last.id).map((s) => s.id)],
  );
});
it('shows the exact shared validator message inline and never submits an invalid skeleton', async () => {
  await mount();
  await click('Edit');
  await text(source.template + '\n');
  await click('Save translation');
  let message = '';
  try {
    validateSnippetTranslation(source.template, source.template + '\n');
  } catch (error) {
    message = (error as Error).message;
  }
  expect(host.querySelector('[role=alert]')?.textContent).toBe(message);
  expect(api.saveSnippetTranslation).not.toHaveBeenCalled();
  await text(source.template);
  expect(host.querySelector('[role=alert]')).toBeNull();
});
it.each([
  ['<bold {{1:Text}} />', '<exotic {{1:Text}} />'],
  ['<bold A /><exotic B />', '<exotic B /><bold A />'],
  ['{{1:Text}} {{0}}', '{{2:Text}} {{0}}'],
  ['<title {{1:Text}} [G_refill] />', '<title {{1:Text}} [G_other] />'],
  ['#{ammo} rounds', '#{other} Schuss'],
  ['var ammo = {{1:3}}\n#{ammo} rounds', 'var other = {{1:3}}\n#{ammo} Schuss'],
  ['Line\n{{1:Text}}', 'Zeile {{1:Text}}'],
])('preserves Worker validation parity for %s', async (english, invalid) => {
  vi.mocked(api.getTeamSnippets).mockResolvedValue({
    team: {
      v: 1,
      snippets: [{ id: 'team:validation', label: 'Validation fixture', template: english }],
    },
  } as Awaited<ReturnType<typeof api.getTeamSnippets>>);
  await mount();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-edit="team:validation"]')!.click(),
  );
  await text(invalid);
  await click('Save translation');
  let message = '';
  try {
    validateSnippetTranslation(english, invalid);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).not.toBe('');
  expect(host.querySelector('[role=alert]')?.textContent).toBe(message);
  expect(api.saveSnippetTranslation).not.toHaveBeenCalled();
});
it('keeps a conflicting draft, reloads the latest base, and restores keyboard focus', async () => {
  vi.mocked(api.saveSnippetTranslation).mockRejectedValueOnce(new api.SnippetConflictError(null));
  await mount();
  await click('Edit');
  await text('// {{1:Kommentar}}');
  await click('Save translation');
  // Web Crypto hashing completes outside React's act() work queue.
  await act(async () => {
    await vi.waitFor(() =>
      expect(api.saveSnippetTranslation).toHaveBeenCalledWith('de', expect.objectContaining({ base })),
    );
  });
  expect(host.querySelector('textarea')?.value).toBe('// {{1:Kommentar}}');
  expect(document.activeElement).toBe(host.querySelector('[data-save]'));
  const latest = { ...base, label: 'Aktuell' };
  vi.mocked(api.getSnippetTranslations).mockResolvedValue({
    translations: { [source.id]: latest },
  });
  await click('Reload');
  expect(host.querySelector('[role=alert]')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('[data-edit]'));
  await click('Edit');
  expect(host.querySelector('input')?.value).toBe('Aktuell');
  vi.mocked(api.saveSnippetTranslation).mockResolvedValue({
    translations: { [source.id]: latest },
  });
  await click('Save translation');
  await act(async () => {
    await vi.waitFor(() => expect(host.querySelector('[role=status]')?.textContent).toContain('Saved'));
  });
  expect(api.saveSnippetTranslation).toHaveBeenLastCalledWith(
    'de',
    expect.objectContaining({ base: latest }),
  );
  expect(host.querySelector('[role=status]')?.textContent).toContain('Saved');
});
it('retries a failed load, cancels editing, and confirms removal with the stored base', async () => {
  vi.mocked(api.getSnippetTranslations).mockRejectedValueOnce(new Error('Offline'));
  await mount();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Offline');
  await click('Retry');
  await click('Edit');
  await click('Cancel');
  expect(document.activeElement).toBe(host.querySelector(`[data-edit="${source.id}"]`));
  await click('Remove');
  await click('Keep');
  expect(document.activeElement).toBe(host.querySelector(`[data-remove="${source.id}"]`));
  await click('Remove');
  vi.mocked(api.saveSnippetTranslation).mockResolvedValue({ translations: {} });
  await click('Remove translation');
  expect(api.saveSnippetTranslation).toHaveBeenCalledWith('de', {
    id: source.id,
    base,
    next: null,
  });
  expect(host.querySelector('textarea')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector(`[data-edit="${source.id}"]`));
});

it('ignores an old language read that completes after a newer read', async () => {
  let complete!: (value: Awaited<ReturnType<typeof api.getSnippetTranslations>>) => void;
  vi.mocked(api.getSnippetTranslations).mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await mount();
  expect(host.querySelector('[role=status]')?.textContent).toContain('Loading');
  vi.mocked(api.getSnippetTranslations).mockResolvedValue({
    translations: { [source.id]: { ...base, label: 'Français' } },
  });
  await act(async () => root.render(<SnippetTranslations lang="fr" onClose={() => {}} />));
  await act(async () => complete({ translations: { [source.id]: base } }));
  await click('Edit');
  expect(host.querySelector('input')?.value).toBe('Français');
});

it('keeps keyboard focus on Retry when a second load also fails', async () => {
  vi.mocked(api.getSnippetTranslations)
    .mockRejectedValueOnce(new Error('Offline'))
    .mockRejectedValueOnce(new Error('Still offline'));
  await mount();
  await click('Retry');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Still offline');
  expect(document.activeElement).toBe(host.querySelector('[data-retry]'));
});
