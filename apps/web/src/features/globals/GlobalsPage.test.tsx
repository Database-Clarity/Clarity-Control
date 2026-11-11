// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { GlobalUsageCount, GlobalUsages } from './GlobalsPage';

it('pages every authored reference and resets the page when selecting another declaration', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalData = useDataStore.getState();
  const originalDrafts = useDraftStore.getState();
  const text = (text: string) => ({
    en: { text, updatedBy: 'test', updatedAt: '2026-11-11T00:00:00Z' },
  });
  const tooltips = {
    2: { hash: 2, text: text('var Rate = 1\nvar Empty = empty'), associated: [] },
    ...Object.fromEntries(
      Array.from({ length: 53 }, (_, index) => [
        index + 10,
        { hash: index + 10, text: text('#Rate'), associated: [] },
      ]),
    ),
  };
  useDataStore.setState({
    data: { bundle: { tooltips }, aliases: {}, items: {}, categories: [] } as unknown as EditorData,
  });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (name: string) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <GlobalUsages hash={2} name={name} />
        </MemoryRouter>,
      ),
    );
  const next = () => host.querySelector<HTMLButtonElement>('[aria-label="Next usages"]')!;
  try {
    await render('Rate');
    expect(host.querySelectorAll('li')).toHaveLength(25);
    expect(host.textContent).toContain('1–25 / 53');
    expect(host.textContent).toContain('References');
    expect(host.textContent).not.toContain('Used in');
    await act(async () => next().click());
    expect(host.textContent).toContain('26–50 / 53');
    await act(async () => next().click());
    expect(host.querySelectorAll('li')).toHaveLength(3);
    expect(next().disabled).toBe(true);
    await render('Empty');
    expect(host.textContent).toContain('No authored references.');
    expect(host.querySelectorAll('li')).toHaveLength(0);
    await render('Rate');
    expect(host.textContent).toContain('1–25 / 53');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useDataStore.setState(originalData);
    useDraftStore.setState(originalDrafts);
  }
});

it('distinguishes reference rows from unique tooltips and uses the finder category label', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalData = useDataStore.getState();
  const originalDrafts = useDraftStore.getState();
  const cell = (text: string) => ({ text, updatedBy: 'test', updatedAt: '2026-11-11T00:00:00Z' });
  useDataStore.setState({
    data: {
      bundle: {
        tooltips: {
          2: { hash: 2, text: { en: cell('var Rate = 1'), de: cell('var Rate = 1') }, associated: [] },
          10: { hash: 10, text: { en: cell('#Rate'), de: cell('#Rate') }, associated: [] },
        },
      },
      aliases: {},
      items: { 10: { hash: 10, name: 'Ember', categoryId: 'subclass-fragment' } },
      categories: [],
    } as unknown as EditorData,
  });
  useDraftStore.setState({ drafts: {}, hydrated: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <GlobalUsageCount hash={2} name="Rate" />
          <GlobalUsages hash={2} name="Rate" />
        </MemoryRouter>,
      ),
    );
    expect(host.textContent).toContain('Used in 1 tooltip');
    expect(host.textContent).not.toContain('Used in 1 tooltips');
    expect(host.querySelectorAll('li')).toHaveLength(2);
    expect(host.textContent).toContain('Fragments');
    expect(host.textContent).not.toContain('subclass-fragment');
    expect(host.querySelector('aside')?.textContent).not.toContain('Used in');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/t/10?lang=en&line=1&variant=10');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useDataStore.setState(originalData);
    useDraftStore.setState(originalDrafts);
  }
});
