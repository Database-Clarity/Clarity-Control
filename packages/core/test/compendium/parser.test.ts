import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseCompendiumGrid,
  parseCompendiumSheet,
  parseCompendiumTabs,
} from '../../src/compendium/parser.js';
import { compendiumCellSchema, sameCell } from '../../src/compendium/types.js';
import { diffCompendium } from '../../src/compendium/diff.js';
import { tooltipSchema } from '../../src/schemas.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
describe('real htmlview golden fixtures', () => {
  it('discovers tab names/gids from Landing without evaluating scripts', () => {
    const tabs = parseCompendiumTabs(fixture('landing'));
    expect(tabs).toHaveLength(16);
    expect(tabs).toContainEqual({ name: 'Weapon Perks', gid: '1662574278' });
    expect(tabs).toContainEqual({ name: 'Arc', gid: '618967225' });
  });
  it('excludes literal uppercase OLD only, including from direct sheet parsing', () => {
    const tabs = parseCompendiumTabs(
      '<a href="?gid=1">OLD Perks</a><a href="?gid=2">old perks</a><a href="?gid=3">Old perks</a><a href="?gid=4">Perks</a>',
    );
    expect(tabs.map((tab) => tab.name)).toEqual(['old perks', 'Old perks', 'Perks']);
    expect(() => parseCompendiumSheet('<html>must not be parsed</html>', '1', 'OLD Perks')).toThrow(
      'Ignored',
    );
  });
  it.each([
    ['weapon', '1662574278', 'Accelerated Heatsink'],
    ['arc', '618967225', 'Amplified'],
    ['armor', '1287885342', 'AION Renewal'],
  ])('normalises %s cell text and styles against a saved golden', (name, gid, key) => {
    const sheet = parseCompendiumSheet(fixture(name), gid);
    expect(sheet).toMatchSnapshot();
    const row = sheet.rows.find((row) => row.name.split('\n')[0] === key)!;
    expect(row.cell.plain).toBe(row.cell.runs.map((run) => run.text).join(''));
    expect(compendiumCellSchema.safeParse(row.cell).success).toBe(true);
    expect(JSON.stringify(sheet)).not.toMatch(/class=|className|"s\d+"/);
  });
  it('combines both description rows under a row-spanned Armor Set name', () => {
    const sheet = parseCompendiumSheet(fixture('armor'), '1287885342');
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0].cell.plain).toContain('2 Piece | Force Converter');
    expect(sheet.rows[0].cell.plain).toContain('4 Piece | Reactive Booster');
    expect(sheet.rows[0].rowIndex).toBe(3);
  });
});

describe('grid, cascade, and normalized persistence', () => {
  it('resolves colspan/rowspan, inheritance, inline resets, entities, links and BR', () => {
    const html = `<style>.ritz .waffle .s1 {color:#6FA8DC;font-weight:700;font-size:10pt}
    .s1 span {font-style:italic} .reset {font-weight:normal;color:rgb(221,126,107)}</style>
    <div class="ritz"><table class="waffle">
    <tr><th>1</th><td colspan="2">Name</td><td>Description</td></tr>
    <tr><th>2</th><td rowspan="2" colspan="2">Test</td><td class="s1">A &amp; B<br><span class="reset" style="font-size:7pt">index</span><a href="https://example.com/"> link</a></td></tr>
    <tr><th>3</th><td>second</td></tr></table></div>`;
    const grid = parseCompendiumGrid(html);
    expect(grid[1].cells[0]).toBe(grid[2].cells[1]);
    expect(grid[1].cells[2]?.cell).toEqual({
      plain: 'A & B\nindex link',
      runs: [
        { text: 'A & B\n', color: '#6fa8dc', bold: true, sizePt: 10 },
        { text: 'index', color: '#dd7e6b', italic: true, sizePt: 7 },
        { text: ' link', color: '#6fa8dc', bold: true, sizePt: 10, href: 'https://example.com/' },
      ],
    });
    expect(parseCompendiumSheet(html, '999').rows[0].cell.plain).toBe('A & B\nindex link\nsecond');
  });
  it('does not repeat row-spanned descriptions or merged description columns', () => {
    const sheet = parseCompendiumSheet(
      `<table><tr><td>Name</td><td>Description</td></tr>
      <tr><td rowspan="2">Test</td><td rowspan="2">one</td></tr><tr><td>unrelated</td></tr></table>`,
      '999',
    );
    expect(sheet.rows[0].cell.plain).toBe('one');
  });
  it('uses physical spreadsheet row numbers when an empty row is omitted by htmlview', () => {
    const sheet = parseCompendiumSheet(
      `<table>
      <tr><th>1</th><td rowspan="2" colspan="2">Notice</td></tr>
      <tr><th>3</th><td>Name</td><td>Description</td></tr>
      <tr><th>4</th><td>Test</td><td>content</td></tr></table>`,
      '999',
    );
    expect(sheet.rows[0]).toMatchObject({ name: 'Test', rowIndex: 4, cell: { plain: 'content' } });
  });
  it('normalizes equivalent styles independent of source class names', () => {
    const sheet = (name: string, style: string) =>
      parseCompendiumSheet(
        `<style>.${name}{${style}}</style><table><tr><td>Name</td><td>Description</td></tr>
      <tr><td>Test</td><td class="${name}">A<span>A</span></td></tr></table>`,
        '999',
      ).rows[0].cell;
    expect(
      sameCell(
        sheet('s1', 'color:#ABC;font-weight:700'),
        sheet('s99', 'font-weight:bold;color:rgb(170,187,204)'),
      ),
    ).toBe(true);
  });
  it('rejects unusable sources explicitly', () => {
    expect(() => parseCompendiumTabs('<html>login required</html>')).toThrow('tabs');
    expect(() => parseCompendiumSheet('<html>login required</html>', '999')).toThrow('table');
    expect(() => parseCompendiumSheet('<table><tr><td>unknown</td></tr></table>', '999')).toThrow(
      'headers',
    );
  });
  it('does not preserve executable links, classes or arbitrary CSS in a snapshot', () => {
    const sheet = parseCompendiumSheet(
      `<table><tr><td>Name</td><td>Description</td></tr>
      <tr><td>Test</td><td><a href="javascript:alert(1)">unsafe</a><script>alert(1)</script><a href="https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F">safe</a></td></tr></table>`,
      '999',
    );
    expect(sheet.rows[0].cell).toEqual({
      plain: 'unsafesafe',
      runs: [{ text: 'unsafe' }, { text: 'safe', href: 'https://example.com/' }],
    });
    expect(compendiumCellSchema.safeParse({ plain: 'x', runs: [{ text: 'y' }] }).success).toBe(
      false,
    );
    expect(
      compendiumCellSchema.safeParse({ plain: 'x', runs: [{ text: 'x', className: 's1' }] })
        .success,
    ).toBe(false);
    expect(tooltipSchema.safeParse({ hash: 123, text: {}, associated: [] }).success).toBe(true);
  });
});

describe('word and style diff', () => {
  it('marks additions/removals and style-only word changes while preserving source runs', () => {
    const before = {
      plain: 'old shared PvE',
      runs: [{ text: 'old shared ' }, { text: 'PvE', color: '#6fa8dc' }],
    };
    const after = {
      plain: 'new shared PvE',
      runs: [{ text: 'new shared ' }, { text: 'PvE', color: '#dd7e6b' }],
    };
    const parts = diffCompendium(before, after);
    expect(
      parts.filter((part) => part.kind === 'removed').map((part) => part.before?.plain),
    ).toEqual(['old']);
    expect(parts.filter((part) => part.kind === 'added').map((part) => part.after?.plain)).toEqual([
      'new',
    ]);
    expect(parts.find((part) => part.kind === 'style')).toEqual({
      kind: 'style',
      before: { plain: 'PvE', runs: [{ text: 'PvE', color: '#6fa8dc' }] },
      after: { plain: 'PvE', runs: [{ text: 'PvE', color: '#dd7e6b' }] },
    });
  });
  it('matches words across run boundaries, including style changes within a word', () => {
    const parts = diffCompendium(
      { plain: 'amplified', runs: [{ text: 'amplified' }] },
      { plain: 'amplified', runs: [{ text: 'ampli' }, { text: 'fied', italic: true }] },
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].kind).toBe('style');
  });
});
