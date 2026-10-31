import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { TooltipPreview } from './TooltipPreview';

test.each(['en', 'de'] as const)(
  'preview shows every section in %s without a weapon picker',
  (lang) => {
    const html = renderToStaticMarkup(
      createElement(TooltipPreview, {
        text: 'Shared\n<weapons Sword>\nBlade\n</weapons>\n<weapons other>\nRest\n</weapons>\n< weapon type (HC) >\nCannon\n< (other) >\nFallback\n<$$>',
        lang,
        name: 'Perk',
        globals: { variables: '', titles: '' },
      }),
    );
    for (const text of [
      'Shared',
      'Sword',
      'Blade',
      'Other weapons',
      'Rest',
      'Hand Cannon',
      'Cannon',
      'Fallback',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('<select');
    expect(html).not.toContain('&lt;weapons');
  },
);

test('preview preserves nested titles, tables and safe link behavior', () => {
  const html = renderToStaticMarkup(
    createElement(TooltipPreview, {
      text: 'title Detail (\n<weapons Glaive>\nNested\n< table wide >\n| Cell\n<$>\n</weapons>\n)\n<title Info [Detail] />\n<link Safe [https://example.com] />\n<link Unsafe [javascript:alert(1)] />',
      lang: 'en',
      name: 'Perk',
      globals: { variables: '', titles: '' },
    }),
  );
  expect(html).toContain('Nested');
  expect(html).toContain('<table');
  expect(html).toContain('Cell');
  expect(html).toContain('href="https://example.com"');
  expect(html).not.toContain('href="javascript:');
});
