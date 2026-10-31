import { expect, test } from 'vitest';
import { inventory, proposeHeadings } from './inventory.mjs';

test('inventories every language, reserved globals and imports, leaving the input untouched', () => {
  const text = '< weapon type (HC) >\nBody\n< (other) >\nRest\n<$$>';
  const value = {
    tooltips: {
      0: { text: { en: { text }, de: { text } } },
      1: { text: { en: { text: `export hidden Part (\n${text}\n)` } } },
    },
  };
  const before = JSON.stringify(value);
  const report = inventory(value);
  expect(report.map((entry) => entry.path)).toEqual([
    ['tooltips', '0', 'text', 'en', 'text'],
    ['tooltips', '0', 'text', 'de', 'text'],
    ['tooltips', '1', 'text', 'en', 'text'],
  ]);
  expect(report.flatMap((entry) => entry.sections)).toHaveLength(6);
  expect(report[0].proposed).toBe('<bold Hand Cannon />\nBody\n<bold Other weapons />\nRest\n');
  expect(JSON.stringify(value)).toBe(before);
});

test('comment examples are excluded and comments after delimiters remain in proposals', () => {
  const source =
    '// <weapons Sword>\n/*\n<weapons Glaive>\n*/\n<weapons Sword> // keep\nBody\n</weapons>';
  const report = proposeHeadings(source);
  expect(report.sections).toHaveLength(1);
  expect(report.sections[0].line).toBe(5);
  expect(report.proposed).toContain('<bold Sword /> // keep');
  expect(report.proposed).toContain('/*\n<weapons Glaive>\n*/');
});
