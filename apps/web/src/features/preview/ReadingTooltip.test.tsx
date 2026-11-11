// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { guidedFixture } from '../../../test/guided-fixture';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { ReadingTooltip } from './ReadingTooltip';

afterEach(() => vi.unstubAllGlobals());

it('renders imported titles, links, tints, and each category variant, and invalidates changed imports', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const data = guidedFixture().editor;
  data.categories = [
    { id: 'weapon-trait', label: 'Traits', group: 'Weapons', order: 1, legacyType: 'Weapon Trait' },
    {
      id: 'enhanced',
      label: 'Enhanced',
      group: 'Weapons',
      order: 2,
      legacyType: 'Weapon Trait Enhanced',
    },
  ];
  data.items[101] = { ...data.items[101], categoryId: 'enhanced' };
  const title = {
    hash: 3,
    associated: [],
    text: {
      en: {
        text: 'title Detail (\nOriginal definition\n)',
        updatedAt: 'now',
        updatedBy: 'fixture',
      },
    },
  };
  data.bundle.tooltips[3] = title;
  useDataStore.setState({ data });
  useDraftStore.setState({ drafts: {} });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const text =
    '<yellow Damage /> <arc/> <title Info [Detail] />\n<link Safe [https://example.com] />\n<link Unsafe [javascript:alert(1)] />\nenhanced (\nEnhanced only\n)';
  try {
    await act(async () => root.render(<ReadingTooltip text={text} hash={100} />));
    expect(host.textContent).toContain('Damage');
    expect(host.textContent).not.toContain('<yellow');
    expect(host.textContent).not.toContain('Enhanced only');
    expect(host.querySelector('[class*=yellow]')).not.toBeNull();
    expect(host.querySelector('[popover="manual"]')?.textContent).toContain('Original definition');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    await act(async () => root.render(<ReadingTooltip text={text} hash={101} />));
    expect(host.textContent).toContain('Enhanced only');
    await act(async () =>
      useDraftStore.setState({
        drafts: {
          3: {
            base: title,
            next: {
              ...title,
              text: {
                en: {
                  text: 'title Detail (\nUpdated definition\n)',
                  updatedAt: 'later',
                  updatedBy: 'fixture',
                },
              },
            },
          },
        },
      }),
    );
    expect(host.querySelector('[popover="manual"]')?.textContent).toContain('Updated definition');
    expect(host.textContent).not.toContain('Original definition');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useDataStore.setState({ data: null });
    useDraftStore.setState({ drafts: {} });
  }
});
