// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxPointers } from '@clarity/core';
import { useAuthStore } from '../../stores/auth';
import { useDataStore, type EditorData } from '../../stores/data';
import { loadSandboxPerkText } from '../manifest/manifestText';
import { getSandboxPointers, putSandboxPointers } from '../../services/sandboxPointers';
import { at, fixture } from './fixture.testSupport';
import { SandboxPerksPage } from './SandboxPerksPage';

vi.mock('../../services/api', async (original) => ({
  ...(await original<typeof import('../../services/api')>()),
  apiUrl: 'https://api.test',
}));
vi.mock('../../services/generator', async (original) => ({
  ...(await original<typeof import('../../services/generator')>()),
  loadSandboxConflicts: vi.fn(async () => fixture().conflicts),
}));
vi.mock('../../services/sandboxPointers', async (original) => ({
  ...(await original<typeof import('../../services/sandboxPointers')>()),
  getSandboxPointers: vi.fn(),
  putSandboxPointers: vi.fn(),
}));

const input = fixture();
let root: Root;
let container: HTMLDivElement;
const empty: SandboxPointers = { version: 1, pointers: {} };

beforeAll(async () => {
  await loadSandboxPerkText(async () => ({ perks: input.perkText }));
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useAuthStore.setState({ user: { id: 1, login: 'alice', role: 'maintainer' }, loading: false });
  useDataStore.setState({
    data: {
      items: input.items,
      categories: [],
      aliases: input.aliases,
      generatorAliases: input.aliases,
      bundle: {
        sourceCommit: 'a'.repeat(40),
        generatedAt: '',
        permissions: { users: {} },
        pushed: {},
        tooltips: input.tooltips,
      },
    } as unknown as EditorData,
  });
  vi.mocked(getSandboxPointers).mockResolvedValue({
    revision: null,
    pointers: empty,
    exporting: true,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render() {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/sandbox-perks']}>
        <SandboxPerksPage />
      </MemoryRouter>,
    ),
  );
  // Picks and conflicts resolve in microtasks.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-state]')];
const row = (hash: string) => rows().find((element) => element.textContent?.includes(hash))!;
const button = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === label || element.textContent?.startsWith(label),
  )!;
const status = () => container.querySelector('select[aria-label="Status"]') as HTMLSelectElement;
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const click = (element: HTMLElement) => act(async () => element.click());
const saveBar = () => container.textContent ?? '';

describe('Sandbox perks worklist', () => {
  it('is maintainer-only and reads nothing for other roles', async () => {
    useAuthStore.setState({ user: { id: 2, login: 'bob', role: 'editor' }, loading: false });
    await render();
    expect(container.textContent).toContain('Maintainer access is required');
    expect(getSandboxPointers).not.toHaveBeenCalled();
  });

  it('lists open rows with counts, stages Apply / Choose / Undo, and discards', async () => {
    await render();
    expect([...status().options].map((option) => option.textContent)).toEqual([
      'Open (7)',
      'Same text (3)',
      'Name matches one (1)',
      'Same name, other text (1)',
      'Suggest no tooltip (1)',
      'Needs judgement (1)',
      'Decided (0)',
      'Changed since decided (0)',
      'All (7)',
    ]);
    expect(rows()).toHaveLength(7);
    expect(saveBar()).toContain('No staged changes.');
    // Apply the suggestion: staged, the row offers Undo instead.
    await click(button(row('703'), 'Apply'));
    expect(row('703').dataset.state).toBe('staged');
    expect(row('703').textContent).toContain('→ ReaperStaged');
    expect(saveBar()).toContain('1 staged change');
    // Choose another candidate in place, then "No tooltip" for a row without a suggestion.
    await click(button(row('706'), 'Choose'));
    const radios = row('706').querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(3);
    await click(radios[2]!);
    expect(row('706').textContent).toContain('No tooltipStaged');
    expect(saveBar()).toContain('2 staged changes');
    // Undo a staged pick: back to the suggestion.
    await click(button(row('703'), 'Undo'));
    expect(row('703').dataset.state).toBe('open');
    // Staged rows stay listed when the filter reads saved state.
    await choose(status(), 'judgement');
    expect(rows().map((element) => element.dataset.state)).toEqual(['staged']);
    await click(button(container, 'Discard'));
    expect(saveBar()).toContain('No staged changes.');
    expect(putSandboxPointers).not.toHaveBeenCalled();
  });

  it('saves the full set of picks with the revision and applies them to the editor aliases', async () => {
    vi.mocked(getSandboxPointers).mockResolvedValue({
      revision: 'b'.repeat(40),
      pointers: {
        version: 1,
        pointers: { 704: { none: true, candidates: [16, 18], by: 1, at } },
      },
      exporting: true,
    });
    const saved: SandboxPointers = {
      version: 1,
      pointers: {
        703: { to: 16, candidates: [16, 17], by: 1, at },
        704: { none: true, candidates: [16, 18], by: 1, at },
      },
    };
    vi.mocked(putSandboxPointers).mockResolvedValue({
      revision: 'c'.repeat(40),
      pointers: saved,
      exporting: true,
    });
    await render();
    await click(button(row('703'), 'Apply'));
    await click(button(container, 'Save'));
    expect(putSandboxPointers).toHaveBeenCalledWith(
      { 703: { to: 16 }, 704: { none: true } },
      'b'.repeat(40),
    );
    expect(container.textContent).toContain('Saved 1 change.');
    expect(useDataStore.getState().data!.aliases).toEqual({
      ...input.aliases,
      703: { to: 16, kind: 'sandbox' },
    });
    // Saved picks leave the Open list.
    expect(rows().some((element) => element.textContent?.includes('703'))).toBe(false);
    await choose(status(), 'decided');
    expect(rows()).toHaveLength(2);
  });

  it('bulk-applies same-text rows after the compiled check and lists the skipped ones', async () => {
    await render();
    await choose(status(), 'same-text');
    await click(button(container, 'Apply all 3'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('Staged 1 after the compiled check');
    expect(container.textContent).toContain('700: compiled output differs (de, base)');
    expect(container.textContent).toContain('702: compiled output differs (de, enhanced)');
    expect(row('701').dataset.state).toBe('staged');
    expect(row('700').dataset.state).toBe('open');
    // Nothing left to apply: the skipped rows stay open, and the bulk button goes away.
    expect(container.textContent).not.toContain('Apply all');
  });

  it('re-checks current text when the editor data is replaced while the page stays open', async () => {
    await render();
    await choose(status(), 'same-text');
    await click(button(container, 'Apply all 3'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(row('701').dataset.state).toBe('staged');
    await click(button(container, 'Discard'));
    const data = useDataStore.getState().data!;
    const tooltips = structuredClone(data.bundle.tooltips);
    tooltips['13']!.text.de!.text = 'Changed translation.';
    await act(async () => {
      useDataStore.setState({ data: { ...data, bundle: { ...data.bundle, tooltips } } });
    });
    await click(button(container, 'Apply all 3'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(row('701').dataset.state).toBe('open');
    expect(container.textContent).toContain('701: compiled output differs (de, base)');
  });

  it('shows a stale revision with a reload, and blocks saving while the exporter lacks picks', async () => {
    vi.mocked(putSandboxPointers).mockRejectedValue(
      new Error((await import('../../services/sandboxPointers')).sandboxPointersChangedMessage),
    );
    await render();
    await click(button(row('703'), 'Apply'));
    await click(button(container, 'Save'));
    expect(container.textContent).toContain('another maintainer saved first');
    expect(button(container, 'Save').disabled).toBe(true);
    await click(button(container, 'Reload picks'));
    expect(getSandboxPointers).toHaveBeenCalledTimes(2);

    vi.mocked(getSandboxPointers).mockResolvedValue({
      revision: null,
      pointers: empty,
      exporting: false,
    });
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    await click(button(row('703'), 'Apply'));
    expect(container.textContent).toContain('does not apply sandbox picks yet');
    expect(button(container, 'Save').disabled).toBe(true);
  });
});
