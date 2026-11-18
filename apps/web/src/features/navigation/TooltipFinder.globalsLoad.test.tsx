// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { TooltipNavigation } from './TooltipNavigation';
import { useAuthStore } from '../../stores/auth';
import { useGlobalIdentities } from '../../stores/globalIdentities';
import type { EditorData } from '../../stores/data';
import { picker, pickOption } from './finderPicker.testUtils';

vi.mock('../../services/globalsFlag', () => ({ globalsEnabled: true }));
vi.mock('../../stores/globalEntries', () => ({ loadGlobalIdentities: vi.fn() }));

it('shows progressive globals without aggregate fallback and keeps an empty category open', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalAuth = useAuthStore.getState();
  const originalIndex = useGlobalIdentities.getState();
  useAuthStore.setState({
    user: { id: 1, login: 'alice', role: 'maintainer' },
    token: 'alice',
    loading: false,
  });
  useGlobalIdentities.setState({ identities: {}, status: 'loading', error: '' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const data = {
    categories: [],
    items: {},
    aliases: {},
    bundle: {
      sourceCommit: 'fixture',
      tooltips: {
        2: { hash: 2, text: { en: { text: 'var StaleVariable = old' } } },
        3: { hash: 3, text: { en: { text: 'title StaleTitle (\nold\n)' } } },
      },
      permissions: { users: {} },
      pushed: {},
    },
  } as unknown as EditorData;
  function Surface() {
    const location = useLocation();
    return (
      <>
        <TooltipNavigation data={data} />
        <output>{location.pathname}</output>
      </>
    );
  }
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/t/2']}>
          <Surface />
        </MemoryRouter>,
      ),
    );
    await act(async () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!.click());
    expect(host.textContent).toContain('Loading globals…');
    expect(host.textContent).not.toContain('StaleVariable');
    await act(async () =>
      useGlobalIdentities.setState({
        identities: {
          g_damage0001: { kind: 'variables', name: 'Damage', definitions: { en: '25%' } },
        },
      }),
    );
    expect(host.querySelector('[role="option"]')?.textContent).toContain('Damage');
    await pickOption(picker(host, 'Category')!, 'globals-titles');
    expect(host.querySelector('output')?.textContent).toBe('/t/3');
    expect(host.querySelector('input[role="combobox"]')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    await act(async () =>
      useGlobalIdentities.setState({
        status: 'ready',
        identities: {
          g_damage0001: { kind: 'variables', name: 'Damage', definitions: { en: '25%' } },
          g_title00001: {
            kind: 'titles',
            name: 'Reload',
            definitions: { en: 'Refills the magazine.' },
          },
        },
      }),
    );
    const row = host.querySelector<HTMLElement>('[role="option"]')!;
    expect(row.textContent).toContain('Reload');
    await act(async () => row.click());
    expect(host.querySelector('output')?.textContent).toBe('/globals/g_title00001');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useAuthStore.setState(originalAuth);
    useGlobalIdentities.setState(originalIndex);
  }
});
