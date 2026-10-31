import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { parseMarkup, weaponTypeNames } from '@clarity/core';
import { TooltipPreview, type TooltipPreviewProps } from './TooltipPreview';
import { allLabelled, previewLines, weaponChoices } from './weaponChoices';

const text = [
  'Shared line.',
  '<weapons Sword, Hand Cannon>',
  'Blade or cannon.',
  '</weapons>',
  '<weapons other>',
  'Everything else.',
  '</weapons>',
].join('\n');

function render(props: Partial<TooltipPreviewProps> = {}) {
  return renderToStaticMarkup(
    createElement(TooltipPreview, {
      text,
      lang: 'en',
      name: 'Frame',
      globals: { variables: '', titles: '' },
      ...props,
    }),
  );
}

const options = (html: string) =>
  [...html.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);

describe('weapon-type picker', () => {
  test('offers the facts of the tooltip plus All (labelled), and previews the first type', () => {
    const html = render({ weaponTypes: ['Hand Cannon', 'Pulse Rifle'] });
    expect(options(html)).toEqual(['Hand Cannon', 'Pulse Rifle', allLabelled]);
    expect(html).toContain('All (labelled)');
    expect(html).toContain('Blade or cannon.');
    expect(html).not.toContain('Everything else.');
    expect(html).toContain('Shared line.');
  });

  test('falls back to every canonical type when no facts are known', () => {
    expect(options(render())).toEqual([...weaponTypeNames, allLabelled]);
    expect(render()).toContain('Everything else.');
  });

  test('previews another type or all sections labelled', () => {
    const pulse = render({
      weaponTypes: ['Hand Cannon', 'Pulse Rifle'],
      initialWeapon: 'Pulse Rifle',
    });
    expect(pulse).toContain('Everything else.');
    expect(pulse).not.toContain('Blade or cannon.');
    const all = render({ weaponTypes: ['Hand Cannon', 'Pulse Rifle'], initialWeapon: allLabelled });
    const plain = all.replace(/<[^>]+>/g, '');
    expect(plain).toContain('Hand Cannon: Blade or cannon.');
    expect(plain).toContain('Pulse Rifle: Everything else.');
    expect(all).toContain('Shared line.');
  });

  describe('localized weapon-type labels', () => {
    const labels = {
      'Hand Cannon': { en: 'Hand Cannon', de: 'Handfeuerwaffe' },
      'Pulse Rifle': { en: 'Pulse Rifle' },
    };
    const facts = ['Hand Cannon', 'Pulse Rifle'];

    test('the labelled view uses the preview language, falling back to English', () => {
      const html = render({
        lang: 'de',
        weaponTypes: facts,
        weaponTypeLabels: labels,
        initialWeapon: allLabelled,
      });
      const plain = html.replace(/<[^>]+>/g, '');
      expect(plain).toContain('Handfeuerwaffe: Blade or cannon.');
      expect(plain).toContain('Pulse Rifle: Everything else.');
      const english = render({
        weaponTypes: facts,
        weaponTypeLabels: labels,
        initialWeapon: allLabelled,
      }).replace(/<[^>]+>/g, '');
      expect(english).toContain('Hand Cannon: Blade or cannon.');
    });

    test('the picker shows localized labels but keeps canonical values', () => {
      const html = render({ lang: 'de', weaponTypes: facts, weaponTypeLabels: labels });
      expect(options(html)).toEqual(['Hand Cannon', 'Pulse Rifle', allLabelled]);
      expect(html).toContain('>Handfeuerwaffe</option>');
      expect(html).toContain('>Pulse Rifle</option>');
    });
  });

  test('an unavailable initial choice falls back to the first type', () => {
    expect(render({ weaponTypes: ['Sword'], initialWeapon: 'Glaive' })).toContain(
      'Blade or cannon.',
    );
  });

  test('is hidden when the text has no weapon-type sections', () => {
    const html = render({ text: 'Plain text.' });
    expect(html).not.toContain('Preview weapon type');
    expect(html).toContain('Plain text.');
  });

  describe('sections that only live in titles', () => {
    const titleText = [
      'See <title Tip [Tip] />',
      '',
      'title Tip (',
      '<weapons Sword>',
      'Sword only',
      '</weapons>',
      '<weapons Glaive>',
      'Glaive only',
      '</weapons>',
      ')',
    ].join('\n');

    test('show the picker and specialise the title content', () => {
      const html = render({ text: titleText, weaponTypes: ['Sword', 'Glaive'] });
      expect(options(html)).toEqual(['Sword', 'Glaive', allLabelled]);
      expect([...html.matchAll(/Sword only|Glaive only/g)].map((match) => match[0])).toEqual([
        'Sword only',
      ]);
      const lines = parseMarkup(titleText).lines;
      const shown = previewLines(lines, 'Glaive', ['Sword', 'Glaive']);
      expect(shown[0].linesContent?.[1].title?.map((line) => line.weaponTypes)).toEqual([
        undefined,
      ]);
      expect(shown[0].linesContent?.[1].title).toHaveLength(1);
    });

    test('table-cell titles are specialised and extra tags in titles are offered', () => {
      const cellText = [
        '< table >',
        '| <title Tip [Tip] /> | x',
        '<$>',
        '',
        'title Tip (',
        '<weapons Grenade>',
        'Boom',
        '</weapons>',
        ')',
      ].join('\n');
      const lines = parseMarkup(cellText).lines;
      expect(weaponChoices(lines, undefined)).toEqual([...weaponTypeNames, 'Grenade']);
      const cell = (choice: string) =>
        previewLines(lines, choice, undefined)[0].table?.[0].rowContent?.[0].cellContent[0].title;
      expect(cell('Grenade')).toHaveLength(1);
      expect(cell('Sword')).toHaveLength(0);
    });
  });

  test('extra tags named by a section are offered when there are no facts', () => {
    const lines = parseMarkup('<weapons Grenade>\nBoom\n</weapons>').lines;
    expect(weaponChoices(lines, undefined)).toEqual([...weaponTypeNames, 'Grenade']);
    expect(previewLines(lines, 'Grenade', undefined).map((line) => line.weaponTypes)).toEqual([
      undefined,
    ]);
  });
});
