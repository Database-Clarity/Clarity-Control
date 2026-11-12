import { displayRevision, displayText } from '@clarity/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  anchorFor,
  browserLang,
  dropMarks,
  emptyDraft,
  isWholeLine,
  lineMark,
  markRange,
  reanchorDraft,
  wordAt,
  wordsOf,
  type DraftNote,
} from './draft';
import { pickerEntries, searchEntries } from './ReportPicker';
import { loadReportRender, renderLines } from './tooltipRender';
import type { ReportCatalog } from '../../../services/reports';

const facet =
  'Collecting Elemental Pickups or destroying a <strand/>Tangle grants energy:\n• <arc/>Ionic Traces, <solar/>Firesprites: 7.5% Light Transcendence Energy \n• <stasis/>Stasis Shards: 5% Darkness';
const globals = { variables: '', titles: '' };

describe('render offsets', () => {
  it('match the core display text for icons, titles, tables, and colours', () => {
    for (const text of [
      facet,
      'A <bold Bold /> and <yellow yellow /> word',
      'Use <title Scorch [Burning damage over time] /> well',
      '< table >\n| a | b |\n| c | d |\n<$>\nAfter the table',
      '🡅 Café <solar/>',
    ]) {
      const rendered = renderLines(text, globals);
      expect(rendered.text).toBe(displayText(text, globals));
      for (const line of rendered.lines)
        for (const cell of line.cells)
          for (const part of cell)
            if (part.kind === 'text')
              expect(rendered.text.slice(part.start, part.end)).toBe(part.text);
    }
  });
});

describe('marking rules', () => {
  const display = displayText(facet, globals);
  const { lines } = renderLines(facet, globals);
  it('marks a line without its bullet and narrows to a word with number punctuation', () => {
    const whole = lineMark(display, lines[1])!;
    expect(display.slice(whole.start, whole.end)).toBe(
      'Ionic Traces, Firesprites: 7.5% Light Transcendence Energy',
    );
    expect(isWholeLine(display, lines[1], whole)).toBe(true);
    const at = display.indexOf('7.5%') + 1;
    const word = wordAt(display, lines[1], at)!;
    expect(display.slice(word.start, word.end)).toBe('7.5%');
    const colon = display.indexOf('Firesprites:') + 2;
    const fire = wordAt(display, lines[1], colon)!;
    expect(display.slice(fire.start, fire.end)).toBe('Firesprites');
    expect(wordsOf(display, lines[1]).map((w) => display.slice(w.start, w.end))[0]).toBe('Ionic');
  });
  it('merges overlapping marks into the earlier note and caps at five', () => {
    let notes: DraftNote[] = [];
    notes = markRange(notes, { start: 0, end: 10 }, 'en').notes;
    notes = markRange(notes, { start: 20, end: 30 }, 'en').notes;
    notes[0].text = 'one';
    notes[1].text = 'two';
    const merged = markRange(notes, { start: 5, end: 25 }, 'en');
    expect(merged.notes).toHaveLength(1);
    expect(merged.notes[0]).toMatchObject({ mark: { start: 0, end: 30 }, text: 'one two' });
    let many: DraftNote[] = [];
    for (let i = 0; i < 6; i++)
      many = markRange(many, { start: i * 10, end: i * 10 + 5 }, 'de').notes;
    expect(many).toHaveLength(5);
    expect(many[0].category).toBe('translation');
  });
  it('re-anchors a restored draft by quote: exact, moved, or Re-mark', async () => {
    const rev = await displayRevision(display);
    const mark = {
      start: display.indexOf('Firesprites'),
      end: display.indexOf('Firesprites') + 11,
    };
    const note: DraftNote = { id: 'a', category: 'other', text: 'x', mark };
    const draft = {
      ...emptyDraft('en'),
      notes: [note],
      anchors: { a: anchorFor(display, rev, lines, mark) },
    };
    expect(reanchorDraft(draft, display, rev).notes[0].mark).toEqual(mark);
    const moved = 'New first line\n' + display;
    const movedRev = await displayRevision(moved);
    const again = reanchorDraft(draft, moved, movedRev).notes[0].mark!;
    expect(moved.slice(again.start, again.end)).toBe('Firesprites');
    const gone = reanchorDraft(draft, 'Different text', 'f'.repeat(16)).notes[0];
    expect(gone).toMatchObject({ mark: null, remark: 'Firesprites', text: 'x' });
    const switched = dropMarks(draft, display, 'de');
    expect(switched.notes[0]).toMatchObject({ mark: null, remark: 'Firesprites', text: 'x' });
    expect(switched.lang).toBe('de');
  });
  it('maps browser languages onto the data languages', () => {
    expect(browserLang(['de-DE'])).toBe('de');
    expect(browserLang(['pt-PT'])).toBe('pt-br');
    expect(browserLang(['zh-TW'])).toBe('zh-cht');
    expect(browserLang(['zh-Hans-CN'])).toBe('zh-chs');
    expect(browserLang(['es-MX'])).toBe('es-mx');
    expect(browserLang(['nl', 'xx'])).toBe('en');
  });
});

const commit = 'a'.repeat(40);
const catalog: ReportCatalog = {
  v: 1,
  sourceCommit: commit,
  items: {
    '1': {
      owner: 1,
      langs: ['en'],
      variant: 'base',
      name: 'Global exports',
      icon: '',
      category: 'none',
      type: 'none',
    },
    '100': {
      owner: 100,
      langs: ['en'],
      variant: 'base',
      name: 'Base Perk',
      icon: '/i.png',
      category: 'weapon-trait',
      type: 'Weapon Trait',
    },
    '101': {
      owner: 100,
      langs: ['en'],
      variant: 'enhanced',
      name: 'Base Perk',
      icon: '/i.png',
      category: 'weapon-trait-enhanced',
      type: 'Weapon Trait Enhanced',
    },
    '102': {
      owner: 100,
      langs: ['en'],
      variant: 'base',
      name: 'Base Perk',
      icon: '/i.png',
      category: 'weapon-trait',
      type: 'Weapon Trait',
    },
    '200': {
      owner: 300,
      langs: ['en'],
      variant: 'override:200',
      name: 'Override Perk',
      icon: '',
      category: 'weapon-trait-enhanced',
      type: 'Weapon Trait Enhanced',
    },
    '300': {
      owner: 300,
      langs: ['en'],
      variant: 'base',
      name: 'Shared Source',
      icon: '',
      category: 'weapon-trait',
      type: 'Weapon Trait',
    },
  },
};
const files: Record<number, Record<string, string>> = {
  1: { en: '' },
  2: { en: 'var dmg = 40' },
  3: { en: '' },
  100: { en: 'Deals #dmg damage.\nenhanced (\n#e Extra line.\n)' },
  200: { en: 'import main from 300' },
  300: { en: 'Shared source text.' },
};

describe('loadReportRender', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubFetch = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const match = /\/([a-f0-9]{40})\/tooltips\/(\d+)\.json$/.exec(url);
        expect(match?.[1]).toBe(commit);
        const text = files[Number(match![2])];
        return text
          ? new Response(
              JSON.stringify({
                text: Object.fromEntries(Object.entries(text).map(([l, t]) => [l, { text: t }])),
              }),
            )
          : new Response('', { status: 404 });
      }),
    );
  it('renders base and enhanced variants with their types and globals', async () => {
    stubFetch();
    const base = (await loadReportRender(100, 'en', catalog))!;
    expect(base.display).toBe('Deals 40 damage.');
    const enhanced = (await loadReportRender(101, 'en', catalog))!;
    expect(enhanced.display).toContain('Extra line.');
    expect(enhanced.rev).toMatch(/^[a-f0-9]{16}$/);
    expect(enhanced.dataCommit).toBe(commit);
  });
  it('follows imports for overrides and falls back to English', async () => {
    stubFetch();
    const override = (await loadReportRender(200, 'de', catalog))!;
    expect(override.display).toBe('Shared source text.');
    expect(override).toMatchObject({ lang: 'en', seenLang: 'de', fallback: true });
    expect(await loadReportRender(999, 'en', catalog)).toBeUndefined();
    expect(await loadReportRender(1, 'en', catalog)).toBeUndefined();
  });
});

describe('picker', () => {
  it('lists each consumer item once and ranks name prefixes first', () => {
    const entries = pickerEntries(catalog);
    expect(entries.map((e) => e.name)).toEqual([
      'Base Perk',
      'Base Perk',
      'Override Perk',
      'Shared Source',
    ]);
    expect(entries.find((e) => e.name === 'Base Perk' && e.category === 'Weapon Perks')?.hash).toBe(
      100,
    );
    expect(searchEntries(entries, 'source').map((e) => e.name)).toEqual(['Shared Source']);
    expect(searchEntries(entries, 'per').map((e) => e.name)[0]).toBe('Base Perk');
    expect(searchEntries(entries, '  ')).toEqual([]);
  });
});
