// @vitest-environment jsdom
// The project page's state across requests, accounts, and file tabs (EXPORT-P4 code review
// F1–F5, F7): the real ProjectPage and ConfigPanel with the Worker calls held by the test.
import type { ExportConfig } from '@clarity/export/config';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { ExportsError, type LoadedProject, type SaveOutcome } from './api';
import { ProjectPage } from './ProjectPage';

const calls = vi.hoisted(() => ({
  load: [] as { id: string; resolve(value: unknown): void; reject(error: unknown): void }[],
  save: [] as { config: unknown; resolve(value: unknown): void }[],
}));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  loadProject: (id: string) =>
    new Promise((resolve, reject) => calls.load.push({ id, resolve, reject })),
  saveProject: (_id: string, _revision: string, config: unknown) =>
    new Promise((resolve) => calls.save.push({ config, resolve })),
}));
vi.mock('./useSite', () => {
  const site = { manifest: null, notices: [], refresh: async () => undefined };
  return {
    useSiteRefresh: () => undefined,
    useSiteStore: (pick: (value: typeof site) => unknown) => pick(site),
  };
});
vi.mock('./PreviewPanel', () => ({ PreviewPanel: () => null }));
vi.mock('../../ui/useMedia', () => ({ useMedia: () => false }));

const uid = (n: number) => `u${String(n).padStart(15, '0')}`;
const project = (id: string, name: string, files = 2): LoadedProject => ({
  id,
  revision: 'r'.repeat(40),
  config: {
    schema: 1,
    id,
    name,
    files: [
      { id: 'a1', uid: uid(1), formatVersion: 1, preset: 'dim' },
      { id: 'b1', uid: uid(2), formatVersion: 1, preset: 'clarity' },
    ].slice(0, files),
  } as ExportConfig,
});
const maintainer = { id: 1, login: 'maint', role: 'maintainer' } as unknown as User;
const partner = { id: 2, login: 'acme', role: null, projects: ['other'] } as unknown as User;

let root: Root;
let host: HTMLDivElement;
let location = '';
let navigate: (to: string) => void = () => undefined;
function Probe() {
  const where = useLocation();
  location = `${where.pathname}${where.search}`;
  navigate = useNavigate();
  return null;
}

async function open(path: string) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Probe />
        <Routes>
          <Route path="/exports/:project" element={<ProjectPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
const settle = async () => act(async () => undefined);
const resolveLoad = async (index: number, value: LoadedProject) => {
  await act(async () => calls.load[index]!.resolve(value));
};
const q = <T extends Element = HTMLElement>(selector: string) =>
  host.querySelector(selector) as T | null;
const tab = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (el) => el.textContent === name,
  );
const idField = () => q<HTMLInputElement>('input[id^="file-id-"]')!;
async function typeId(value: string) {
  const field = idField();
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const key = async (field: HTMLElement, name: string) =>
  act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
const click = async (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
const saveButton = () =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((el) =>
    /^Sav/.test(el.textContent ?? ''),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls.load.length = 0;
  calls.save.length = 0;
  useAuthStore.setState({ user: maintainer });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('ProjectPage state', () => {
  it('F3: a renamed second file stays selected and the URL follows', async () => {
    await open('/exports/p1?file=b1');
    await resolveLoad(0, project('p1', 'One'));
    expect(tab('b1')!.getAttribute('aria-selected')).toBe('true');
    await typeId('renamed');
    await key(idField(), 'Enter');
    await settle();
    expect(tab('renamed')!.getAttribute('aria-selected')).toBe('true');
    expect(location).toBe('/exports/p1?file=renamed');
  });

  it('a URL without a file shows the first file (Back from a file tab)', async () => {
    await open('/exports/p8?file=b1');
    await resolveLoad(0, project('p8', 'Eight'));
    expect(tab('b1')!.getAttribute('aria-selected')).toBe('true');
    await act(async () => navigate('/exports/p8'));
    expect(tab('a1')!.getAttribute('aria-selected')).toBe('true');
    expect(location).toBe('/exports/p8');
  });

  it('F4: a pending invalid id does not follow to another file tab', async () => {
    await open('/exports/p2?file=b1');
    await resolveLoad(0, project('p2', 'Two'));
    await typeId('9bad');
    await key(idField(), 'Enter');
    expect(idField().value).toBe('9bad');
    expect(idField().getAttribute('aria-invalid')).toBe('true');
    await click(tab('a1')!);
    expect(idField().value).toBe('a1');
    expect(idField().getAttribute('aria-invalid')).toBeNull();
  });

  it('F4: leaving the field drops an invalid id', async () => {
    await open('/exports/p3');
    await resolveLoad(0, project('p3', 'Three'));
    await typeId('9bad');
    await act(async () => idField().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(idField().value).toBe('a1');
  });

  it('F1: the config is read-only while a save is on its way', async () => {
    await open('/exports/p4');
    await resolveLoad(0, project('p4', 'Four'));
    await typeId('a2');
    await key(idField(), 'Enter');
    await click(saveButton()!);
    expect(calls.save).toHaveLength(1);
    expect(q('#export-file-panel')!.hasAttribute('inert')).toBe(true);
    expect(tab('+ File')).toBeUndefined();
    const add = [...host.querySelectorAll('button')].find((el) => el.textContent === '+ File');
    expect((add as HTMLButtonElement).disabled).toBe(true);
    const saved = structuredClone(calls.save[0]!.config) as ExportConfig;
    await act(async () =>
      calls.save[0]!.resolve({
        kind: 'saved',
        revision: 's'.repeat(40),
        config: saved,
        commit: null,
      } satisfies SaveOutcome),
    );
    expect(q('#export-file-panel')!.hasAttribute('inert')).toBe(false);
    expect(saveButton()!.disabled).toBe(true);
    expect(tab('a2')).toBeDefined();
  });

  it('F2: a slow load of the previous project never lands on the next one', async () => {
    await open('/exports/pa');
    await act(async () => navigate('/exports/pb'));
    const b = calls.load.findIndex((call) => call.id === 'pb');
    await resolveLoad(b, project('pb', 'Project B'));
    await resolveLoad(
      calls.load.findIndex((call) => call.id === 'pa'),
      project('pa', 'Project A'),
    );
    expect(q('h1')!.textContent).toBe('Project B');
    expect(location).toBe('/exports/pb');
  });

  it('F2: a save reply after leaving does not reach the next project', async () => {
    await open('/exports/pc');
    await resolveLoad(0, project('pc', 'Project C'));
    await typeId('c2');
    await key(idField(), 'Enter');
    await click(saveButton()!);
    await act(async () => navigate('/exports/pd'));
    await resolveLoad(
      calls.load.findIndex((call) => call.id === 'pd'),
      project('pd', 'Project D'),
    );
    await act(async () =>
      calls.save[0]!.resolve({
        kind: 'saved',
        revision: 's'.repeat(40),
        config: { ...project('pc', 'Project C').config },
        commit: null,
      } satisfies SaveOutcome),
    );
    expect(q('h1')!.textContent).toBe('Project D');
    expect(tab('a1')).toBeDefined();
  });

  const addButton = () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (el) => el.textContent === '+ File',
    )!;
  /** The submitted config as the Worker stores it: new files get a uid. */
  const stored = (index: number) => {
    const config = structuredClone(calls.save[index]!.config) as ExportConfig;
    config.files = config.files.map((file, n) => ({ ...file, uid: file.uid ?? uid(70 + n) }));
    return config;
  };

  it('re-check F1: a save that lands after leaving reaches the project when it comes back', async () => {
    await open('/exports/pe');
    await resolveLoad(0, project('pe', 'Project E', 1));
    await click(addButton());
    expect(tab('descriptions')).toBeDefined();
    await click(saveButton()!);
    await act(async () => navigate('/exports/pf'));
    await resolveLoad(
      calls.load.findIndex((call) => call.id === 'pf'),
      project('pf', 'Project F'),
    );
    const config = stored(0);
    await act(async () =>
      calls.save[0]!.resolve({
        kind: 'saved',
        revision: 's'.repeat(40),
        config,
        commit: null,
      } satisfies SaveOutcome),
    );
    await act(async () => navigate('/exports/pe'));
    const back = calls.load.map((call) => call.id).lastIndexOf('pe');
    await resolveLoad(back, { ...project('pe', 'Project E'), revision: 's'.repeat(40), config });
    const ids = [...host.querySelectorAll('[role="tab"]')].map((el) => el.textContent);
    expect(ids).toEqual(['a1', 'descriptions']);
    expect(saveButton()!.disabled).toBe(true);
    expect(q('[role="alert"]')).toBeNull();
  });

  it('re-check F1: coming back while the save is on its way waits for its reply', async () => {
    await open('/exports/pg');
    await resolveLoad(0, project('pg', 'Project G', 1));
    await click(addButton());
    await click(saveButton()!);
    await act(async () => navigate('/exports/ph'));
    await act(async () => navigate('/exports/pg'));
    expect(calls.load.filter((call) => call.id === 'pg')).toHaveLength(1);
    expect(saveButton()!.textContent).toBe('Saving…');
    expect(q('#export-file-panel')!.hasAttribute('inert')).toBe(true);
    const config = stored(0);
    await act(async () =>
      calls.save[0]!.resolve({
        kind: 'saved',
        revision: 's'.repeat(40),
        config,
        commit: null,
      } satisfies SaveOutcome),
    );
    expect([...host.querySelectorAll('[role="tab"]')].map((el) => el.textContent)).toEqual([
      'a1',
      'descriptions',
    ]);
    expect(saveButton()!.disabled).toBe(true);
    expect(q('#export-file-panel')!.hasAttribute('inert')).toBe(false);
  });

  it('re-check 2 F1: a read sent before a save cannot replace its result', async () => {
    await open('/exports/pj');
    const before = project('pj', 'Project J', 1);
    await resolveLoad(0, before);
    await typeId('renamed');
    await key(idField(), 'Enter');
    await act(async () => navigate('/exports/pk'));
    await resolveLoad(1, project('pk', 'Project K'));
    await act(async () => navigate('/exports/pj'));
    // The background read of the cached draft is held across the whole save.
    expect(calls.load).toHaveLength(3);
    await click(saveButton()!);
    const config = structuredClone(calls.save[0]!.config) as ExportConfig;
    await act(async () =>
      calls.save[0]!.resolve({
        kind: 'saved',
        revision: 's'.repeat(40),
        config,
        commit: null,
      } satisfies SaveOutcome),
    );
    await resolveLoad(2, before);
    expect(tab('renamed')).toBeDefined();
    expect(tab('a1')).toBeUndefined();
    expect(saveButton()!.disabled).toBe(true);
    // Read it again: the cache holds the saved config and revision, not the older read.
    await act(async () => navigate('/exports/pk'));
    await act(async () => navigate('/exports/pj'));
    expect(tab('renamed')).toBeDefined();
  });

  it('re-check F2: renaming an unsaved file keeps its tab and the URL follows', async () => {
    await open('/exports/pi');
    await resolveLoad(0, project('pi', 'Project I', 1));
    await click(addButton());
    expect(tab('descriptions')!.getAttribute('aria-selected')).toBe('true');
    const field = idField();
    await typeId('fresh');
    await key(field, 'Enter');
    expect(tab('fresh')!.getAttribute('aria-selected')).toBe('true');
    expect(location).toBe('/exports/pi?file=fresh');
    expect(idField()).toBe(field);
  });

  it('F5: Old URLs stay manageable with no active file', async () => {
    await open('/exports/p5');
    const loaded = project('p5', 'Five', 0);
    loaded.config.retained = [
      {
        path: 'p5/v1/old.json',
        uid: uid(9),
        formatVersion: 1,
        snapshot: { id: 'old', uid: uid(9), formatVersion: 1, preset: 'dim' },
        until: '2026-01-01T00:00:00.000Z',
      },
    ];
    await resolveLoad(0, loaded);
    expect(host.textContent).toContain('This project has no files yet');
    expect([...host.querySelectorAll('h2')].map((el) => el.textContent)).toContain('Old URLs');
    expect(host.textContent).toContain('p5/v1/old.json');
  });

  it('F7: another account never sees a cached draft it cannot read', async () => {
    await open('/exports/p7');
    await resolveLoad(0, project('p7', 'Seven'));
    await typeId('draft');
    await key(idField(), 'Enter');
    await act(async () => useAuthStore.setState({ user: partner }));
    // The new account's own read is refused: nothing of the old draft stays on screen.
    expect(host.textContent).not.toContain('draft');
    await act(async () =>
      calls.load.at(-1)!.reject(new ExportsError(403, 'This project is not yours')),
    );
    expect(q('[role="alert"]')!.textContent).toContain('cannot open this export project');
    expect(saveButton()).toBeUndefined();
    expect(host.querySelector('input')).toBeNull();
  });
});
