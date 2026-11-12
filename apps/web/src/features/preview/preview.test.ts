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

test('preview draws element-tagged text as the icon, then the tinted text, with no second icon', () => {
  const render = (text: string) =>
    renderToStaticMarkup(
      createElement(TooltipPreview, {
        text,
        lang: 'en',
        name: 'Perk',
        globals: { variables: '', titles: '' },
      }),
    );
  const tagged = render('Gain <solar Scorch /> stacks.');
  const lowered = render('Gain <solar/>Scorch stacks.');
  const icon = /<span class="([^"]*solar[^"]*)"><span><\/span><\/span>/;
  const text = /<span class="([^"]*)"><span>Scorch<\/span><\/span>/;
  // The icon span is the same as the lowered form's; the text span carries the tint classes.
  expect(tagged.match(icon)?.[1]).toBe(lowered.match(icon)?.[1]);
  const tint = tagged.match(text)?.[1].split(' ') ?? [];
  expect(tint).toHaveLength(2);
  expect(tint).toContain(lowered.match(icon)?.[1]);
  expect(tagged).not.toContain('&lt;solar');
});
