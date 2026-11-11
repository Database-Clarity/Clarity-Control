// G-ROUNDTRIP (spec section 9): config -> page state -> config is identical, for fixtures and every
// preset; every page edit and its inverse gives back the saved bytes; schema migration n -> n+1
// runs on load; unknown keys are refused.
import { legacyPresets, newStyleFile, styles, styleShapes } from '@clarity/export';
import {
  configSchema,
  migrateConfig,
  symbolIds,
  type ExportConfig,
  type StyleFile,
} from '@clarity/export/config';
import { describe, expect, it } from 'vitest';
import {
  addFile,
  changedRows,
  fromConfig,
  isDirty,
  rebase,
  removeFile,
  renameFile,
  resetRow,
  resetRows,
  ruleForMode,
  rowChanged,
  setData,
  setPreset,
  setRow,
  setShape,
  toConfig,
  toggleData,
  type ProjectState,
} from './configModel';
import { randomFiles } from './testConfigs';

const uid = (n: number) => `u${String(n).padStart(15, '0')}`;
const categories = ['weapon-trait', 'weapon-frame', 'armor-set-bonus', 'armor-mod-general'];

/** Fixtures: the P3 load-test project shape, every preset, both shapes, and random files. */
function fixtures(): ExportConfig[] {
  const configs: ExportConfig[] = [];
  configs.push({
    schema: 1,
    id: 'legacy',
    name: 'Every legacy preset',
    files: legacyPresets.slice(0, 3).map((preset, n) => ({
      id: `l-${preset.toLowerCase()}`,
      uid: uid(n),
      formatVersion: 1 as const,
      preset,
    })),
  });
  configs.push({
    schema: 1,
    id: 'legacy-b',
    name: 'More legacy presets',
    files: legacyPresets.slice(3, 6).map((preset, n) => ({
      id: `l-${preset.toLowerCase()}`,
      uid: uid(10 + n),
      formatVersion: 1 as const,
      preset,
    })),
  });
  configs.push({
    schema: 1,
    id: 'legacy-c',
    name: 'Last legacy presets',
    files: legacyPresets.slice(6).map((preset, n) => ({
      id: `l-${preset.toLowerCase()}`,
      uid: uid(20 + n),
      formatVersion: 1 as const,
      preset,
    })),
  });
  for (const shape of ['lines', 'text'] as const)
    configs.push({
      schema: 1,
      id: `styles-${shape}`,
      name: `Styles, ${shape}`,
      files: styles.slice(0, 3).map((style, n) => ({
        ...newStyleFile(`s-${style}`, style, undefined, shape),
        uid: uid(30 + n),
      })),
    });
  configs.push({
    schema: 1,
    id: 'random',
    name: 'Random',
    files: randomFiles(3, categories).map((file, n) => ({ ...file, uid: uid(40 + n) })),
    retained: [
      {
        path: 'random/v1/old.json',
        uid: uid(99),
        formatVersion: 1,
        snapshot: { id: 'old', uid: uid(99), formatVersion: 1, preset: 'dim' },
        until: '2027-02-11T12:00:00.000Z',
      },
    ],
  });
  return configs.map((config) => configSchema.parse(config));
}

const bytes = (config: ExportConfig) => JSON.stringify(config);
const firstKey = (state: ProjectState) => state.config.files[0]!.uid!;

describe('G-ROUNDTRIP', () => {
  it('config -> page state -> config is identical for fixtures and every preset', () => {
    for (const config of fixtures()) {
      const state = fromConfig(config, 'a'.repeat(40));
      expect(bytes(toConfig(state))).toBe(bytes(config));
      expect(isDirty(state)).toBe(false);
      // The stored JSON as the Worker returns it reads back identically too.
      expect(bytes(migrateConfig(JSON.parse(bytes(toConfig(state)))))).toBe(bytes(config));
    }
  });

  it('every page edit undone by hand gives back the saved bytes', () => {
    for (const config of fixtures().filter((candidate) => candidate.id.startsWith('styles'))) {
      const start = fromConfig(config, 'a'.repeat(40));
      const key = firstKey(start);
      const file = start.config.files[0] as StyleFile;
      const steps: [
        string,
        (state: ProjectState) => ProjectState,
        (state: ProjectState) => ProjectState,
      ][] = [
        [
          'category',
          (state) => toggleData(state, key, 'categories', ['weapon-trait'], true),
          (state) => toggleData(state, key, 'categories', ['weapon-trait'], false),
        ],
        [
          'language',
          (state) => toggleData(state, key, 'languages', ['de'], true),
          (state) => toggleData(state, key, 'languages', ['de'], false),
        ],
        [
          'key',
          (state) => toggleData(state, key, 'keys', ['name'], false),
          (state) => toggleData(state, key, 'keys', ['name'], true),
        ],
        [
          'flag',
          (state) => setData(state, key, 'frameAliases', !file.data.frameAliases),
          (state) => setData(state, key, 'frameAliases', file.data.frameAliases),
        ],
        [
          'rename',
          (state) => renameFile(state, key, 'renamed'),
          (state) => renameFile(state, key, file.id),
        ],
      ];
      for (const symbol of symbolIds) {
        const rule = file.format.symbols[symbol];
        const other = rule?.mode === 'drop' ? 'replace' : 'drop';
        steps.push([
          `symbol ${symbol}`,
          (state) =>
            setRow(
              state,
              key,
              symbol,
              ruleForMode(state, state.config.files[0] as StyleFile, symbol, other),
            ),
          (state) =>
            setRow(
              state,
              key,
              symbol,
              ruleForMode(state, state.config.files[0] as StyleFile, symbol, rule!.mode),
            ),
        ]);
      }
      for (const [name, edit, undo] of steps) {
        const edited = edit(start);
        expect(isDirty(edited), name).toBe(true);
        expect(bytes(undo(edited).config), name).toBe(bytes(config));
      }
    }
  });

  it('Replace values come back after switching away and back', () => {
    const config = fixtures().find((candidate) => candidate.id === 'styles-text')!;
    const start = fromConfig(config, 'a'.repeat(40));
    const key = firstKey(start);
    const file = () => (state: ProjectState) => state.config.files[0] as StyleFile;
    let state = setRow(start, key, 'bold', { mode: 'replace', before: '<b>', after: '</b>' });
    state = setRow(state, key, 'bold', ruleForMode(state, file()(state), 'bold', 'drop'));
    state = setRow(state, key, 'bold', ruleForMode(state, file()(state), 'bold', 'replace'));
    expect(file()(state).format.symbols.bold).toEqual({
      mode: 'replace',
      before: '<b>',
      after: '</b>',
    });
  });

  it('marks rows changed from the style and resets rows and sections', () => {
    const config = fixtures().find((candidate) => candidate.id === 'styles-lines')!;
    let state = fromConfig(config, 'a'.repeat(40));
    const key = firstKey(state);
    const file = () => state.config.files[0] as StyleFile;
    expect(changedRows(file())).toEqual([]);
    state = setRow(state, key, 'arc', { mode: 'drop' });
    state = setRow(state, key, 'titles', { mode: 'drop' });
    expect(rowChanged(file(), 'arc')).toBe(true);
    expect(changedRows(file())).toEqual(['arc', 'titles']);
    state = resetRow(state, key, 'arc');
    expect(changedRows(file())).toEqual(['titles']);
    state = resetRows(state, key, changedRows(file()));
    expect(bytes(state.config)).toBe(bytes(config));
  });

  it('switching style seeds its format; legacy presets take no data; shape text drops keep', () => {
    const config = fixtures().find((candidate) => candidate.id === 'styles-lines')!;
    let state = fromConfig(config, 'a'.repeat(40));
    const key = firstKey(state);
    state = setPreset(state, key, 'markdown');
    const markdown = state.config.files[0] as StyleFile;
    expect(markdown.uid).toBe(key);
    expect(markdown.shape).toBe(styleShapes.markdown);
    expect(changedRows(markdown)).toEqual([]);
    state = setPreset(state, key, 'dim');
    expect(state.config.files[0]).toEqual({
      id: markdown.id,
      uid: key,
      formatVersion: 1,
      preset: 'dim',
    });
    state = setPreset(state, key, 'structured');
    state = setShape(state, key, 'text');
    const text = state.config.files[0] as StyleFile;
    expect(Object.values(text.format.symbols).some((rule) => rule?.mode === 'keep')).toBe(false);
    expect(configSchema.safeParse(state.config).success).toBe(true);
  });

  it('adds up to three files with free ids and removes them', () => {
    let state = fromConfig(
      configSchema.parse({ schema: 1, id: 'empty', name: 'Empty', files: [] }),
      'a'.repeat(40),
    );
    state = addFile(addFile(addFile(state)));
    expect(state.config.files.map((file) => file.id)).toEqual(['descriptions', 'file-2', 'file-3']);
    expect(configSchema.safeParse(state.config).success).toBe(true);
    state = removeFile(state, 'new:file-2');
    expect(state.config.files.map((file) => file.id)).toEqual(['descriptions', 'file-3']);
  });

  it('after a 409 keeps the edited files on the newest stored config', () => {
    const config = fixtures().find((candidate) => candidate.id === 'styles-lines')!;
    let state = fromConfig(config, 'a'.repeat(40));
    state = setRow(state, firstKey(state), 'arc', { mode: 'drop' });
    const stored = structuredClone(config);
    stored.name = 'Renamed by a maintainer';
    (stored.files[1] as StyleFile).data.languages = ['en', 'fr'];
    const next = rebase(state, stored, 'b'.repeat(40));
    expect(next.revision).toBe('b'.repeat(40));
    expect(next.config.name).toBe('Renamed by a maintainer');
    expect((next.config.files[0] as StyleFile).format.symbols.arc).toEqual({ mode: 'drop' });
    expect((next.config.files[1] as StyleFile).data.languages).toEqual(['en', 'fr']);
    expect(isDirty(next)).toBe(true);
  });

  it('migrates schema n -> n+1 on load and refuses unknown keys', () => {
    const v0 = { schema: 1, id: 'old', name: 'Old', files: [], legacyName: 'x' };
    const table = {
      1: (config: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...config, schema: 2 };
        delete next.legacyName;
        return next;
      },
    };
    const migrated = migrateConfig(v0, table, 2) as unknown as Record<string, unknown>;
    expect(migrated).toEqual({ schema: 2, id: 'old', name: 'Old', files: [] });
    expect(() => migrateConfig({ ...v0 })).toThrow();
    expect(() =>
      migrateConfig({
        schema: 1,
        id: 'x1',
        name: 'X',
        files: [{ ...newStyleFile('a1', 'plain'), extra: true }],
      }),
    ).toThrow();
  });
});
