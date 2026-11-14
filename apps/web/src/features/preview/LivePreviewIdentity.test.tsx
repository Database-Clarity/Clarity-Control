// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { LivePreviewIdentity } from './LivePreviewIdentity';
import { TooltipPreview } from './TooltipPreview';
import { useDataStore, type EditorData } from '../../stores/data';
import { publishSteppingTarget, settleStepping } from '../navigation/steppingActivity';
import { resetNamesForTests, useNamesStore } from '../terms/names';

it('shows the live identity in the preview language, with English available to reveal', async () => {
  const host = document.createElement('div');
  const originalData = useDataStore.getState();
  const root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const file = {
    v: 1 as const,
    lang: 'de',
    manifestVersion: 'm1',
    names: { 20: 'Neuer Gegenstand', 21: 'Nächster Gegenstand' },
    itemNames: {},
    setNames: {},
  };
  const markup = (lang: 'en' | 'de') =>
    createElement(
      LivePreviewIdentity.Provider,
      { value: { hash: 20, name: 'Newest item' } },
      createElement(TooltipPreview, {
        name: 'Previous item',
        text: 'Body',
        lang,
        globals: { variables: '', titles: '' },
        fill: true,
      }),
    );
  try {
    await act(async () => root.render(markup('de')));
    act(() => useNamesStore.setState({ byLang: { de: { status: 'ready', file } } }));
    expect(host.innerHTML).toContain('Neuer Gegenstand');
    expect(host.innerHTML).toContain('title="Newest item"');
    expect(host.innerHTML).not.toContain('Previous item</');
    act(() =>
      useDataStore.setState({
        data: {
          categories: [],
          aliases: {},
          items: {
            21: {
              hash: 21,
              name: 'Next item',
              icon: '',
              categoryId: 'test',
              inGameDescription: '',
            },
          },
          bundle: { tooltips: {} },
        } as unknown as EditorData,
      }),
    );
    act(() => publishSteppingTarget('/t/21?lang=de', () => {}));
    expect(host.querySelector('header')?.textContent).toContain('Nächster Gegenstand');
    expect(host.textContent).toContain('Body');
    act(settleStepping);
    act(() => root.render(markup('en')));
    expect(host.innerHTML).not.toContain('Neuer Gegenstand');
    expect(host.innerHTML).not.toContain('show English original');
  } finally {
    await act(async () => root.unmount());
    resetNamesForTests();
    useDataStore.setState(originalData);
  }
});

it('paints the newest workspace header while keeping the previous description visible', () => {
  const props = {
    name: 'Previous item',
    text: 'Previous description stays on screen',
    lang: 'en' as const,
    globals: { variables: '', titles: '' },
  };
  const markup = renderToStaticMarkup(
    createElement(
      LivePreviewIdentity.Provider,
      { value: { name: 'Newest item', icon: 'https://example.com/new.png' } },
      createElement(TooltipPreview, { ...props, fill: true }),
      createElement(TooltipPreview, { ...props, name: 'Independent popover' }),
    ),
  );
  expect(markup).toContain('Newest item');
  expect(markup).toContain('https://example.com/new.png');
  expect(markup).toContain('Previous description stays on screen');
  expect(markup).toContain('Independent popover');
  expect(markup).not.toContain('Opening');
});

it('updates the urgent header leaf while the document component stays retained', () => {
  const original = useDataStore.getState();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let documents = 0;
  function RetainedDocument() {
    documents++;
    return createElement(TooltipPreview, {
      name: 'Previous item',
      text: 'Previous description stays visible',
      lang: 'en',
      globals: { variables: '', titles: '' },
      fill: true,
    });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  try {
    useDataStore.setState({
      data: {
        categories: [],
        aliases: {},
        items: {
          20: {
            hash: 20,
            name: 'Newest item',
            icon: 'https://example.com/new.png',
            categoryId: 'test',
            inGameDescription: '',
          },
        },
        bundle: { tooltips: {} },
      } as unknown as EditorData,
    });
    act(() =>
      root.render(
        createElement(
          LivePreviewIdentity.Provider,
          { value: { name: 'Previous item' } },
          createElement(RetainedDocument),
        ),
      ),
    );
    act(() => publishSteppingTarget('/t/20', () => {}));
    expect(host.querySelector('header')?.textContent).toContain('Newest item');
    expect(host.querySelector('header img')?.getAttribute('src')).toBe(
      'https://example.com/new.png',
    );
    expect(host.textContent).toContain('Previous description stays visible');
    expect(documents).toBe(1);
  } finally {
    act(() => {
      root.unmount();
      settleStepping();
    });
    host.remove();
    useDataStore.setState(original);
  }
});
