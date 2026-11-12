// Page state of a project (spec section 8) and every edit the page makes, as pure functions.
// The page edits the config itself (G-ROUNDTRIP: config -> page state -> config is identical), and
// every edit keeps key and list order, so undoing an edit by hand gives back the saved bytes.
import {
  isLegacyFile,
  styles,
  symbolIds,
  type ExportConfig,
  type ExportFile,
  type FileData,
  type FileFormat,
  type LegacyPreset,
  type Shape,
  type StyleFile,
  type SymbolId,
  type SymbolRule,
} from '@clarity/export/config';
import { legacyPresets, newStyleFile, styleShapes, type Style } from '@clarity/export';

export type Preset = Style | LegacyPreset;
export const presets: readonly Preset[] = [...styles, ...legacyPresets];

export interface ProjectState {
  /** The config as last loaded or saved, and its revision (CAS). */
  saved: ExportConfig;
  revision: string;
  /** The config being edited. */
  config: ExportConfig;
  /** Replace values a row had before it switched mode, so switching back restores them. */
  memory: Readonly<Record<string, unknown>>;
}

export const fromConfig = (config: ExportConfig, revision: string): ProjectState => ({
  saved: config,
  revision,
  config,
  memory: {},
});
export const toConfig = (state: ProjectState): ExportConfig => state.config;
export const isDirty = (state: ProjectState) =>
  JSON.stringify(state.config) !== JSON.stringify(state.saved);

/** A file's identity across renames: its uid once saved, else its id. */
export const fileKey = (file: Pick<ExportFile, 'id' | 'uid'>) => file.uid ?? `new:${file.id}`;

/** The saved version of a file (same uid), for list order and "Live file" checks. */
export const savedFile = (state: ProjectState, file: ExportFile) =>
  state.saved.files.find((candidate) =>
    file.uid ? candidate.uid === file.uid : !candidate.uid && candidate.id === file.id,
  );

// Format rows ---------------------------------------------------------------------------------

export type RuleRow = 'titles' | 'links' | 'elementTags' | 'spacer';
export type FormatRow = SymbolId | RuleRow;
export const ruleRows: readonly RuleRow[] = ['titles', 'links', 'elementTags', 'spacer'];
export const formatRows: readonly FormatRow[] = [...symbolIds, ...ruleRows];
const isRuleRow = (row: FormatRow): row is RuleRow => (ruleRows as readonly string[]).includes(row);

/** The format a style seeds, for this file's shape (what "changed from preset" compares with). */
export const presetFormat = (file: StyleFile): FileFormat =>
  newStyleFile(file.id, file.preset, file.data, file.shape).format;

export function rowValue(format: FileFormat, row: FormatRow): unknown {
  if (isRuleRow(row)) return format[row];
  return format.symbols[row];
}

export const rowChanged = (file: StyleFile, row: FormatRow) =>
  JSON.stringify(rowValue(file.format, row)) !== JSON.stringify(rowValue(presetFormat(file), row));

export const changedRows = (file: StyleFile, rows: readonly FormatRow[] = formatRows) =>
  rows.filter((row) => rowChanged(file, row));

function withRow(format: FileFormat, row: FormatRow, value: unknown): FileFormat {
  if (isRuleRow(row)) return { ...format, [row]: value } as FileFormat;
  const symbols = { ...format.symbols };
  if (value === undefined) delete symbols[row];
  else symbols[row] = value as SymbolRule;
  return { ...format, symbols };
}

// Data lists keep the saved order, so toggling an entry off and on again restores the bytes.
function ordered<T>(list: readonly T[], saved: readonly T[] | undefined): T[] {
  if (!saved) return [...list];
  const rank = (value: T) => {
    const index = saved.indexOf(value);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return list
    .map((value, index) => ({ value, index }))
    .sort((a, b) => rank(a.value) - rank(b.value) || a.index - b.index)
    .map(({ value }) => value);
}

// State edits ---------------------------------------------------------------------------------

function editFile(
  state: ProjectState,
  key: string,
  edit: (file: ExportFile) => ExportFile,
  memory = state.memory,
): ProjectState {
  const files = state.config.files.map((file) => (fileKey(file) === key ? edit(file) : file));
  return { ...state, config: { ...state.config, files }, memory };
}

const styleOnly = (file: ExportFile, edit: (file: StyleFile) => StyleFile): ExportFile =>
  isLegacyFile(file) ? file : edit(file);

/** Sets one format row. Leaving Replace (or Inline) remembers its values for the way back. */
export function setRow(state: ProjectState, key: string, row: FormatRow, value: unknown) {
  const file = state.config.files.find((candidate) => fileKey(candidate) === key);
  if (!file || isLegacyFile(file)) return state;
  const memoryKey = `${key}:${row}`;
  const current = rowValue(file.format, row) as { mode?: string } | undefined;
  let memory = state.memory;
  if (current?.mode === 'replace' || current?.mode === 'inline')
    memory = { ...memory, [memoryKey]: current };
  return editFile(
    state,
    key,
    (target) =>
      styleOnly(target, (style) => ({ ...style, format: withRow(style.format, row, value) })),
    memory,
  );
}

/** The rule a mode button sets: Replace/Inline come back with their remembered values. */
export function ruleForMode(
  state: ProjectState,
  file: StyleFile,
  row: FormatRow,
  mode: string,
): unknown {
  const remembered = state.memory[`${fileKey(file)}:${row}`] as { mode?: string } | undefined;
  if (remembered?.mode === mode) return remembered;
  const preset = rowValue(presetFormat(file), row) as { mode?: string } | undefined;
  if (preset?.mode === mode) return preset;
  if (mode === 'replace')
    return row === 'links' ? { mode, pattern: ['', '', '', ''] } : { mode, before: '', after: '' };
  if (mode === 'inline') return { mode, pattern: ['', '', '', ''] };
  return { mode };
}

export const resetRow = (state: ProjectState, key: string, row: FormatRow) => {
  const file = state.config.files.find((candidate) => fileKey(candidate) === key);
  if (!file || isLegacyFile(file)) return state;
  return setRow(state, key, row, structuredClone(rowValue(presetFormat(file), row)));
};

export const resetRows = (state: ProjectState, key: string, rows: readonly FormatRow[]) =>
  rows.reduce((next, row) => resetRow(next, key, row), state);

/** Switches a file's style. A style keeps the data; a legacy preset takes none (frozen). */
export function setPreset(state: ProjectState, key: string, preset: Preset): ProjectState {
  return editFile(state, key, (file) => {
    if (file.preset === preset) return file;
    const base = { id: file.id, ...(file.uid ? { uid: file.uid } : {}), formatVersion: 1 as const };
    if ((legacyPresets as readonly string[]).includes(preset))
      return { ...base, preset: preset as LegacyPreset };
    const style = preset as Style;
    const data = isLegacyFile(file) ? undefined : file.data;
    const seeded = newStyleFile(file.id, style, data, styleShapes[style]);
    return {
      ...base,
      preset: seeded.preset,
      shape: seeded.shape,
      data: seeded.data,
      format: seeded.format,
    };
  });
}

/** Lines keep spans; text has no `keep`, so kept symbols, titles, and links drop. */
export const setShape = (state: ProjectState, key: string, shape: Shape) =>
  editFile(state, key, (file) =>
    styleOnly(file, (style) => {
      if (style.shape === shape) return style;
      const reshaped = newStyleFile(style.id, style.preset, style.data, shape);
      const format = structuredClone(style.format);
      if (shape === 'text') {
        for (const symbol of symbolIds)
          if (format.symbols[symbol]?.mode === 'keep') format.symbols[symbol] = { mode: 'drop' };
        if (format.titles.mode === 'keep') format.titles = { mode: 'drop' };
        if (format.links.mode === 'keep') format.links = { mode: 'drop' };
      }
      return { ...style, shape: reshaped.shape, format };
    }),
  );

export function setData<K extends keyof FileData>(
  state: ProjectState,
  key: string,
  field: K,
  value: FileData[K],
): ProjectState {
  return editFile(state, key, (file) =>
    styleOnly(file, (style) => {
      const saved = savedFile(state, style);
      const savedValue = saved && !isLegacyFile(saved) ? saved.data[field] : undefined;
      const next = Array.isArray(value)
        ? (ordered(value as unknown[], savedValue as unknown[] | undefined) as FileData[K])
        : value;
      return { ...style, data: { ...style.data, [field]: next } };
    }),
  );
}

/** Adds or removes entries of a data list (categories, sandbox perks, languages, keys). */
export function toggleData(
  state: ProjectState,
  key: string,
  field: 'categories' | 'sandboxPerks' | 'languages' | 'keys',
  values: readonly string[],
  on: boolean,
): ProjectState {
  const file = state.config.files.find((candidate) => fileKey(candidate) === key);
  if (!file || isLegacyFile(file)) return state;
  const current = file.data[field] as readonly string[];
  const next = on
    ? [...current, ...values.filter((value) => !current.includes(value))]
    : current.filter((value) => !values.includes(value));
  return setData(state, key, field, next as FileData[typeof field]);
}

export const renameFile = (state: ProjectState, key: string, id: string) =>
  editFile(state, key, (file) => ({ ...file, id }));

/** A free file id: `descriptions`, then `file-2`, `file-3`. */
export function newFileId(config: ExportConfig): string {
  const taken = new Set([
    ...config.files.map((file) => file.id),
    ...(config.retained ?? []).map((entry) => entry.snapshot.id),
  ]);
  if (!taken.has('descriptions')) return 'descriptions';
  for (let n = 2; ; n++) if (!taken.has(`file-${n}`)) return `file-${n}`;
}

export function addFile(state: ProjectState, preset: Style = 'structured'): ProjectState {
  const file = newStyleFile(newFileId(state.config), preset);
  return { ...state, config: { ...state.config, files: [...state.config.files, file] } };
}

export const removeFile = (state: ProjectState, key: string): ProjectState => ({
  ...state,
  config: {
    ...state.config,
    files: state.config.files.filter((file) => fileKey(file) !== key),
  },
});

/** Maintainers delete a retained URL once its window has ended (spec section 5). */
export function removeRetained(state: ProjectState, path: string): ProjectState {
  const retained = (state.config.retained ?? []).filter((entry) => entry.path !== path);
  const config = { ...state.config };
  if (retained.length || state.saved.retained) config.retained = retained;
  else delete config.retained;
  return { ...state, config };
}

/**
 * After a 409: the newest stored config becomes the base, and the edits stay on top. Files the
 * page did not change take the stored version; changed files keep the page's version.
 */
export function rebase(state: ProjectState, stored: ExportConfig, revision: string): ProjectState {
  const changed = (file: ExportFile) => {
    const before = savedFile(state, file);
    return !before || JSON.stringify(before) !== JSON.stringify(file);
  };
  const files: ExportFile[] = [];
  // Files the store has that the page's saved copy does not: created since (by this page's own
  // save, or someone else's). A page file without a uid and the same id is that file.
  const created = stored.files.filter(
    (fresh) => fresh.uid && !state.saved.files.some((file) => file.uid === fresh.uid),
  );
  for (const file of state.config.files) {
    const twin = !file.uid && created.find((fresh) => fresh.id === file.id);
    if (twin) {
      const bare = JSON.stringify(twin, (name, value: unknown) =>
        name === 'uid' ? undefined : value,
      );
      files.push(bare === JSON.stringify(file) ? twin : { ...file, uid: twin.uid });
    } else if (changed(file)) files.push(file);
    else {
      const fresh = stored.files.find((candidate) => file.uid && candidate.uid === file.uid);
      if (fresh) files.push(fresh);
    }
  }
  // Files someone else added stay, unless the page removed them before.
  for (const fresh of stored.files)
    if (
      fresh.uid &&
      !files.some((file) => file.uid === fresh.uid) &&
      !state.saved.files.some((file) => file.uid === fresh.uid)
    )
      files.push(fresh);
  const config: ExportConfig = { ...stored, files };
  if (JSON.stringify(state.config.retained) !== JSON.stringify(state.saved.retained))
    config.retained = state.config.retained;
  return { saved: stored, revision, config, memory: state.memory };
}

/** The style files' presets without the legacy ones, for the style select. */
export const isStyle = (preset: string): preset is Style =>
  (styles as readonly string[]).includes(preset);

export const legacyLabel = (preset: LegacyPreset) =>
  preset === 'clarityV2' ? 'Legacy: clarityV2' : `Legacy: ${preset}.json`;
