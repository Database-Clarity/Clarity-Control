import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseCompendiumGrid,
  parseCompendiumSheet,
  parseCompendiumTabs,
} from '../../src/compendium/parser.js';
import { isTrackedCompendiumTab } from '../../src/compendium/config.js';
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
    expect(
      ['GOLD Perks', 'BOLD', 'HOLD_ON', 'Perks (OLD)', 'OLD', 'OLD_Perks', 'Perks-OLD'].filter(
        isTrackedCompendiumTab,
      ),
    ).toEqual(['GOLD Perks', 'BOLD', 'HOLD_ON']);
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
  it('captures each cell background from classes and inline style, never from its text', () => {
    const html = `<style>.s2 {background-color:#2e3c4e;color:#ccc} .s3 {background-color:var(--gm3-x,#1b130f)}
    .s4 {background-color:rgba(0,0,0,0)} .s5 {background-color:#ffffff80}</style>
    <table class="waffle">
    <tr><th>1</th><td>Name</td><td>Description</td></tr>
    <tr><th>2</th><td>Classed</td><td class="s2">one</td></tr>
    <tr><th>3</th><td>Variable</td><td class="s3">two</td></tr>
    <tr><th>4</th><td>Inline</td><td class="s2" style="background-color:#ABCDEF">three</td></tr>
    <tr><th>5</th><td>Clear</td><td class="s4">four</td></tr>
    <tr><th>6</th><td>Translucent</td><td class="s5">five</td></tr>
    <tr><th>7</th><td>None</td><td>six</td></tr></table>`;
    const rows = parseCompendiumSheet(html, '999').rows;
    expect(rows.map((row) => row.cell.background)).toEqual([
      '#2e3c4e',
      '#1b130f',
      '#abcdef',
      undefined,
      undefined,
      undefined,
    ]);
    // The background is display-only: same text and styling on another background is the same cell.
    const [classed] = rows;
    expect(sameCell(classed.cell, { plain: 'one', runs: classed.cell.runs })).toBe(true);
    expect(compendiumCellSchema.safeParse(classed.cell).success).toBe(true);
  });
  it('keeps the first description background for combined and row-spanned rows', () => {
    const sheet = parseCompendiumSheet(
      `<style>.a {background-color:#112233} .b {background-color:#445566}</style>
      <table><tr><td>Name</td><td>Description</td></tr>
      <tr><td rowspan="2">Test</td><td class="a">one</td></tr>
      <tr><td class="b">two</td></tr></table>`,
      '999',
    );
    expect(sheet.rows[0].cell).toMatchObject({ plain: 'one\ntwo', background: '#112233' });
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

describe('source cell alignment', () => {
  it.each(['weapon', 'arc', 'armor'])(
    'retains published %s fixture alignment in grid and descriptions',
    (name) => {
      const gid = { weapon: '1662574278', arc: '618967225', armor: '1287885342' }[name]!;
      const sheet = parseCompendiumSheet(fixture(name), gid);
      expect(
        sheet.grid!.some(({ cell }) => cell.runs.some((run) => run.textAlign === 'center')),
      ).toBe(true);
      expect(
        sheet.rows.some(({ cell }) => cell.runs.some((run) => run.textAlign === 'center')),
      ).toBe(true);
    },
  );
  it('resolves class specificity, inherited alignment, inline overrides and mixed joined cells', () => {
    const sheet = parseCompendiumSheet(
      `<style>
      .ritz .waffle .s1 {text-align:center;color:#6FA8DC;font-weight:700}
      .s1 {text-align:right} .left {text-align:left}
      </style><div class="ritz"><table class="waffle">
      <tr><td>Name</td><td>Description</td><td>Description</td><td>Description</td></tr>
      <tr><td>Test</td><td class="s1">Centre<br><i>second</i></td>
      <td class="left">Left</td><td class="s1" style="text-align:right">Right</td></tr>
      </table></div>`,
      '999',
    );
    const cell = sheet.rows[0].cell;
    expect(cell.plain).toBe('Centre\nsecond\nLeft\nRight');
    expect(cell.runs.filter((run) => run.text.trim()).map((run) => run.textAlign)).toEqual([
      'center',
      'center',
      'left',
      'right',
    ]);
    expect(cell.runs[1]).toMatchObject({ italic: true, bold: true, color: '#6fa8dc' });
    expect(compendiumCellSchema.parse(cell)).toEqual(cell);
    const old = { plain: 'Centre', runs: [{ text: 'Centre' }] };
    expect(compendiumCellSchema.parse(old)).toEqual(old);
    expect(
      diffCompendium(old, { plain: 'Centre', runs: [{ text: 'Centre', textAlign: 'center' }] })[0]
        .kind,
    ).toBe('equal');
  });
});
