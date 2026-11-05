import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { LivePreviewIdentity } from './LivePreviewIdentity';
import { TooltipPreview } from './TooltipPreview';

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
