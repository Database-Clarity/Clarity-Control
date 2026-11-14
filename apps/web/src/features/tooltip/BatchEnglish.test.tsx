// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { UpcomingEnglish } from '../translations/upcomingEnglish';
import { useSettingsStore } from '../../stores/settings';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { upcomingStore } from './UpcomingSwitch.store';
import { guidedFixture } from '../../../test/guided-fixture';

it('uses the batch future globals for rendered and markup-only English, including nested imports and titles', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const data = guidedFixture().editor;
  useDataStore.setState({ data });
  const drafts = useDraftStore.getState().drafts;
  const store = upcomingStore();
  const previous = store.getState();
  const device = useSettingsStore.getState().device;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const globals = {
    variables: 'var Damage = 42',
    titles: 'title Detail (\nBatch title definition\n)',
    imports: { 999: 'import main from 1000', 1000: 'Batch nested import' },
  };
  const text = '<solar Scorch />\nimport main from 999\n<title Info [Detail] />\n#Damage';
  const preference = (englishSource: 'current' | 'changes') =>
    useSettingsStore.setState({
      device: { ...device, remembered: { ...device.remembered, englishSource } },
    });
  try {
    preference('current');
    await act(async () =>
      root.render(
        <UpcomingEnglish hash={100} current={undefined} upcoming={text} globals={globals} editor />,
      ),
    );
    expect(host.querySelector('aside[aria-label="Upcoming English"]')).not.toBeNull();
    expect(host.textContent).toContain('Batch nested import');
    expect(host.textContent).toContain('42');
    expect(host.querySelector('[popover="manual"]')?.textContent).toContain(
      'Batch title definition',
    );
    await act(async () => {
      const batchId = '01JF00000000000000000000AA';
      const overlay = Object.fromEntries(
        Object.entries({ 2: globals.variables, 3: globals.titles, ...globals.imports }).map(
          ([hash, text]) => {
            const tooltip = {
              hash: Number(hash),
              associated: [],
              text: { en: { text, updatedAt: '2026-11-14T00:00:00Z', updatedBy: 'fixture' } },
            };
            return [hash, { base: tooltip, next: tooltip }];
          },
        ),
      );
      store.setState({
        memberOf: {
          100: {
            id: batchId,
            name: 'Batch',
            status: 'draft',
            notBefore: null,
            revision: 1,
            hashes: [100],
          },
        },
        loads: {
          [batchId]: { state: 'ready', revision: 1, upcoming: { overlay, stale: {}, members: {} } },
        },
      });
      preference('changes');
      root.render(
        <UpcomingEnglish
          hash={100}
          current={text.replace('<solar Scorch />', '<solar/>Scorch')}
          upcoming={text}
          editor
        />,
      );
    });
    expect(host.querySelector('[data-markup-only]')).not.toBeNull();
    expect(host.textContent).toContain('Batch nested import');
    expect(host.querySelector('[popover="manual"]')?.textContent).toContain(
      'Batch title definition',
    );
    expect(useDraftStore.getState().drafts).toBe(drafts);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.setState(previous);
    useSettingsStore.setState({ device });
    useDataStore.setState({ data: null });
    vi.unstubAllGlobals();
  }
});
