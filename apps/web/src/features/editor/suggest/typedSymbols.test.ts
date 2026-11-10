// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useDataStore, type EditorData } from '../../../stores/data';
import { validateChanges } from '../../../services/save/validation';
import { subclassSymbol } from './typedSymbols';
import { acceptChip, chipState, chipsExtension, markChipShown } from '../markupRow/chips';

const facts = vi.hoisted(() => ({ items: {} as Record<number, unknown> }));
vi.mock('../../compendium/manifestFacts', () => ({ loadManifestFacts: () => facts }));

const keywords = [
  ['Radiant', 'solar'],
  ['Restoration', 'solar'],
  ['Blind', 'arc'],
  ['Bolt Charge', 'arc'],
  ['Devour', 'void'],
  ['Invisibility', 'void'],
  ['Suppression', 'void'],
  ['Weaken', 'void'],
  ['Sever', 'strand'],
  ['Threadling', 'strand'],
  ['Shatter', 'stasis'],
  ['Slow', 'stasis'],
] as const;

function catalogue(
  entries: { name: string; description?: string; text?: string; categoryId?: string }[],
) {
  useDataStore.setState({
    data: {
      categories: [],
      aliases: {},
      items: Object.fromEntries(
        entries.map((entry, i) => [
          i + 100,
          {
            hash: i + 100,
            name: entry.name,
            icon: '',
            categoryId: entry.categoryId ?? 'verbs',
            inGameDescription: entry.description ?? '',
          },
        ]),
      ),
      bundle: {
        tooltips: Object.fromEntries(
          entries
            .filter((entry) => entry.text)
            .map((entry, i) => [
              i + 100,
              {
                hash: i + 100,
                associated: [],
                text: {
                  en: { text: entry.text, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'a' },
                },
              },
            ]),
        ),
      },
    } as unknown as EditorData,
  });
}
afterEach(() => {
  facts.items = {};
  useDataStore.setState({ data: null });
});

test.each([
  ...keywords,
  ['Weakened', 'void'] as const,
  ['Slowed', 'stasis'] as const,
  ['Severed', 'strand'] as const,
])('%s gets an automatic element chip that preserves the word on acceptance', (word, icon) => {
  catalogue(keywords.map(([name]) => ({ name })));
  const view = new EditorView({ state: EditorState.create({ extensions: [chipsExtension()] }) });
  try {
    const doc = `Gains ${word}`;
    view.dispatch({
      changes: { from: 0, insert: doc },
      selection: { anchor: doc.length },
      userEvent: 'input.type',
    });
    expect(chipState(view.state)?.item).toMatchObject({
      id: `icon:${icon}`,
      insert: `<${icon}/>`,
    });
    markChipShown(view, true);
    expect(acceptChip(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`Gains <${icon}/>${word}`);
  } finally {
    view.destroy();
  }
});

test('any data-derived element wins, including across duplicate keyword records', () => {
  facts.items = { 100: { inventory: { plug: { plugCategoryIdentifier: 'subclass.strand' } } } };
  catalogue([{ name: 'Radiant', text: '<void/>Data', description: '[Arc]' }]);
  expect(subclassSymbol('Radiant', 'Radiant')?.icon).toBe('strand');
  facts.items = {};
  catalogue([{ name: 'Radiant' }, { name: 'Radiant', description: '[Arc]' }]);
  expect(subclassSymbol('Radiant', 'Radiant')?.icon).toBe('arc');
  catalogue([{ name: 'Radiant', text: '<void/>Data' }]);
  expect(subclassSymbol('Radiant', 'Radiant')?.icon).toBe('void');
  catalogue([
    { name: 'Radiant', description: '[Arc]' },
    { name: 'Radiant', description: '[Void]' },
  ]);
  expect(subclassSymbol('Radiant', 'Radiant')?.icon).toBeNull();
});

test('conflicting elements in one description prevent fallback, including with missing-data duplicates', () => {
  catalogue([{ name: 'Radiant', description: '[Arc] [Void]' }]);
  expect(subclassSymbol('Radiant', 'Radiant')?.icon).toBeNull();
  catalogue([{ name: 'Radiant', description: '[Arc] [Void]' }, { name: 'Radiant' }]);
  expect(subclassSymbol('Radiant', 'Radiant')?.icon).toBeNull();
  catalogue([{ name: 'Radiant', description: '[Arc] [Arc]' }]);
  expect(subclassSymbol('Radiant', 'Radiant')?.icon).toBe('arc');
});

test('fallback requires a catalogue keyword, respects boundaries, and resets with the catalogue', () => {
  catalogue([{ name: 'constructor' }]);
  expect(subclassSymbol('constructor', 'constructor')?.icon).toBeNull();
  catalogue([{ name: 'Radiant', categoryId: 'subclass-aspect' }]);
  expect(subclassSymbol('Radiant', 'Radiant')?.icon).toBeNull();
  catalogue([{ name: 'Radiant' }]);
  expect(subclassSymbol('radiant', 'radiant')?.icon).toBe('solar');
  expect(subclassSymbol('notRadiant', 'Radiant')).toBeNull();
  expect(subclassSymbol('<Radiant', 'Radiant')).toBeNull();
  useDataStore.setState({ data: null });
  expect(subclassSymbol('Radiant', 'Radiant')).toBeNull();
});

test('editor save validation accepts a prismatic tooltip', () => {
  catalogue([{ name: 'Transcendence' }]);
  const next = {
    hash: 100,
    associated: [],
    text: {
      en: { text: '<prismatic/>Transcendence', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'a' },
    },
  };
  expect(validateChanges([{ hash: 100, base: null, next }], useDataStore.getState().data!)).toEqual(
    [],
  );
});
