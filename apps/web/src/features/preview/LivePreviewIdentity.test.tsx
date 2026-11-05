// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { LivePreviewIdentity } from './LivePreviewIdentity';
import { TooltipPreview } from './TooltipPreview';
import { useDataStore, type EditorData } from '../../stores/data';
import { publishSteppingTarget, settleStepping } from '../navigation/steppingActivity';

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
