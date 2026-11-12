// The config column (spec section 8): the file (id, style, shape), Data (category tree with
// Tooltips and Sandbox perks columns, languages, keys, aliases, Bungie-identical), and Format
// (one 28px row per symbol and rule; changed-from-preset markers and Reset per row and section).
import { deployedLegacyPresets, legacyPresets, type Style } from '@clarity/export';
import {
  exportLanguages,
  isLegacyFile,
  isValidId,
  itemKeys,
  styles as styleNames,
  symbolIds,
  type ExportFile,
  type FileData,
  type StyleFile,
} from '@clarity/export/config';
import {
  memo,
  useCallback,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { categoryGroups } from '../../services/categoryLabels';
import { useDataStore } from '../../stores/data';
import { EnhancedArrow } from '../../ui/EnhancedArrow';
import { When } from '../../ui/When';
import { classNames } from '../preview/TooltipPreview';
import { languageLabel } from '../../languageLabels';
import {
  changedRows,
  legacyLabel,
  removeFile,
  removeRetained,
  renameFile,
  resetRow,
  resetRows,
  ruleForMode,
  rowChanged,
  rowValue,
  ruleRows,
  setData,
  setPreset,
  setRow,
  setShape,
  toggleData,
  type FormatRow,
  type Preset,
  type ProjectState,
  type RuleRow,
} from './configModel';
import styles from './Exports.module.scss';

type Update = (next: (state: ProjectState) => ProjectState) => void;

export function ConfigPanel({
  state,
  file,
  fileKey: key,
  maintainer,
  projectId,
  onChange,
  onRemoved,
}: {
  state: ProjectState;
  file: ExportFile;
  fileKey: string;
  maintainer: boolean;
  projectId: string;
  onChange(next: (state: ProjectState) => ProjectState): void;
  onRemoved(): void;
}) {
  const update: Update = onChange;
  return (
    <div className={styles.config}>
      {/* Keyed by the file: a pending id never carries over to another file's tab. */}
      <FileSection
        key={key}
        state={state}
        file={file}
        fileKey={key}
        update={update}
        onRemoved={onRemoved}
      />
      {isLegacyFile(file) ? (
        <LegacyNote preset={file.preset} />
      ) : (
        <>
          <DataSection file={file} fileKey={key} update={update} />
          <FormatSection file={file} fileKey={key} update={update} />
        </>
      )}
      <RetainedSection
        state={state}
        maintainer={maintainer}
        projectId={projectId}
        update={update}
      />
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHeader}>
        <h2 id={id} className={styles.sectionTitle}>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

// File ----------------------------------------------------------------------------------------

function FileSection({
  state,
  file,
  fileKey: key,
  update,
  onRemoved,
}: {
  state: ProjectState;
  file: ExportFile;
  fileKey: string;
  update: Update;
  onRemoved(): void;
}) {
  const [draftId, setDraftId] = useState<string | null>(null);
  const idValue = draftId ?? file.id;
  const taken = state.config.files.some((other) => other !== file && other.id === idValue);
  const idProblem = !isValidId(idValue)
    ? '2–32 of a–z, 0–9, -; starts with a letter'
    : taken
      ? 'Another file has this id'
      : null;
  // Enter keeps an invalid id on screen with its problem; leaving the field drops it, so the
  // field always ends up showing the id the config holds.
  const commitId = (leaving: boolean) => {
    if (draftId === null) return;
    if (!idProblem && draftId !== file.id) update((current) => renameFile(current, key, draftId));
    if (!idProblem || leaving) setDraftId(null);
  };
  const saved = state.saved.files.some((other) => other.uid && other.uid === file.uid);
  return (
    <Section title="File">
      <div className={styles.formGrid}>
        <label className={styles.formLabel} htmlFor={`file-id-${key}`}>
          File id
        </label>
        <div className={styles.formControl}>
          <input
            id={`file-id-${key}`}
            className={styles.field}
            value={idValue}
            maxLength={32}
            spellCheck={false}
            aria-invalid={idProblem ? true : undefined}
            aria-describedby={idProblem ? `file-id-problem-${key}` : `file-id-help-${key}`}
            onChange={(event) => setDraftId(event.target.value.toLowerCase())}
            onBlur={() => commitId(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitId(false);
              if (event.key === 'Escape') setDraftId(null);
            }}
          />
          {idProblem ? (
            <span id={`file-id-problem-${key}`} className={styles.badText}>
              {idProblem}
            </span>
          ) : (
            <span id={`file-id-help-${key}`} className={styles.meta}>
              v{file.formatVersion}/{idValue}.json
            </span>
          )}
        </div>
        <label className={styles.formLabel} htmlFor={`file-style-${key}`}>
          Style
        </label>
        <div className={styles.formControl}>
          <select
            id={`file-style-${key}`}
            className={styles.select}
            value={file.preset}
            onChange={(event) =>
              update((current) => setPreset(current, key, event.target.value as Preset))
            }
          >
            <optgroup label="Styles">
              {styleNames.map((style) => (
                <option key={style} value={style}>
                  {styleLabel(style)}
                </option>
              ))}
            </optgroup>
            <optgroup label="Legacy (frozen, byte-identical)">
              {legacyPresets.map((preset) => (
                <option key={preset} value={preset}>
                  {legacyLabel(preset)}
                </option>
              ))}
            </optgroup>
          </select>
          {!isLegacyFile(file) && (
            <Segmented
              label="Shape"
              value={file.shape}
              options={[
                { value: 'lines', label: 'Lines' },
                { value: 'text', label: 'Text' },
              ]}
              onChange={(shape) => update((current) => setShape(current, key, shape))}
            />
          )}
        </div>
      </div>
      <div className={styles.fileFoot}>
        <span className={styles.meta}>
          {isLegacyFile(file)
            ? 'Legacy files keep their old shape.'
            : file.shape === 'lines'
              ? 'Lines: each line is a list of spans with class names.'
              : 'Text: one string per language.'}
        </span>
        <button
          type="button"
          className={styles.quiet}
          onClick={() => {
            update((current) => removeFile(current, key));
            onRemoved();
          }}
          title={saved ? 'Its URL keeps updating for 3 months after you save (old URL)' : undefined}
        >
          Remove file
        </button>
      </div>
    </Section>
  );
}

const styleLabel = (style: Style) =>
  ({
    structured: 'Structured (lines)',
    markdown: 'Markdown',
    discord: 'Discord',
    plain: 'Plain text',
  })[style];

function LegacyNote({ preset }: { preset: ExportFile['preset'] }) {
  const deployed = (deployedLegacyPresets as readonly string[]).includes(preset);
  return (
    <Section title="Legacy: unchanged">
      <p className={styles.note}>
        {deployed
          ? `This file is byte-identical to ${preset}.json at the old URL; the preview shows the deployed file. `
          : 'clarityV2 has no file at the old URLs; the preview builds it from the published data. '}
        Choosing a style leaves legacy mode and makes every part of the file customisable.
      </p>
    </Section>
  );
}

// Data ----------------------------------------------------------------------------------------

function DataSection({
  file,
  fileKey: key,
  update,
}: {
  file: StyleFile;
  fileKey: string;
  update: Update;
}) {
  const categories = useDataStore((state) => state.data?.categories);
  const tree = useMemo(() => {
    const known = categories ?? [];
    const groups = categoryGroups
      .map((group) => ({
        name: group as string,
        items: known.filter((category) => category.group === group),
      }))
      .concat({
        name: 'Other',
        items: known.filter(
          (category) => !(categoryGroups as readonly string[]).includes(category.group),
        ),
      })
      .filter((group, index, all) => group.items.length && all.indexOf(group) === index);
    const knownIds = new Set(known.map((category) => category.id));
    const unknown = [...new Set([...file.data.categories, ...file.data.sandboxPerks])].filter(
      (id) => !knownIds.has(id),
    );
    if (unknown.length)
      groups.push({
        name: 'Not in the catalog',
        items: unknown.map((id) => ({ id, label: id, group: 'Unknown', order: 0 })),
      });
    return groups;
  }, [categories, file.data.categories, file.data.sandboxPerks]);
  const toggle = useCallback(
    (field: 'categories' | 'sandboxPerks', ids: string[], on: boolean) =>
      update((current) => toggleData(current, key, field, ids, on)),
    [update, key],
  );
  const chosen = file.data.categories.length;
  return (
    <Section
      title="Data"
      aside={
        <span className={styles.meta}>
          {chosen} {chosen === 1 ? 'category' : 'categories'}, {file.data.sandboxPerks.length} with
          sandbox perks
        </span>
      }
    >
      <table className={styles.tree}>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col" className={styles.checkCol}>
              Tooltips
            </th>
            <th scope="col" className={styles.checkCol}>
              <span className={styles.longLabel}>Sandbox perks</span>
              <span className={styles.shortLabel} aria-hidden="true">
                Sandbox
              </span>
            </th>
          </tr>
        </thead>
        {tree.map((group) => (
          <CategoryGroup
            key={group.name}
            name={group.name}
            ids={group.items.map((item) => item.id)}
            labels={group.items.map((item) => item.label)}
            categories={file.data.categories}
            sandbox={file.data.sandboxPerks}
            onToggle={toggle}
          />
        ))}
      </table>
      {!categories && <p className={styles.meta}>Loading categories…</p>}
      <div className={styles.dataRows}>
        <div className={styles.dataRow}>
          <span className={styles.formLabel} id={`languages-${key}`}>
            Languages
          </span>
          <div className={styles.chips} role="group" aria-labelledby={`languages-${key}`}>
            {exportLanguages.map((language) => {
              const on = file.data.languages.includes(language);
              return (
                <button
                  key={language}
                  type="button"
                  className={styles.chip}
                  aria-pressed={on}
                  title={languageLabel(language)}
                  disabled={on && file.data.languages.length === 1}
                  onClick={() =>
                    update((current) => toggleData(current, key, 'languages', [language], !on))
                  }
                >
                  {language}
                </button>
              );
            })}
          </div>
        </div>
        <div className={styles.dataRow}>
          <span className={styles.formLabel} id={`keys-${key}`}>
            Keys
          </span>
          <div className={styles.checks} role="group" aria-labelledby={`keys-${key}`}>
            {itemKeys.map((itemKey) => (
              <label key={itemKey} className={styles.check}>
                <input
                  type="checkbox"
                  checked={file.data.keys.includes(itemKey)}
                  onChange={(event) =>
                    update((current) =>
                      toggleData(current, key, 'keys', [itemKey], event.target.checked),
                    )
                  }
                />
                {itemKey}
              </label>
            ))}
          </div>
        </div>
        <div className={styles.dataRow}>
          <span className={styles.formLabel}>Include</span>
          <div className={styles.checks}>
            <Flag
              label="Frame aliases"
              title="Frames shared by several weapons, each under its own hash"
              checked={file.data.frameAliases}
              onChange={(value) =>
                update((current) => setData(current, key, 'frameAliases', value))
              }
            />
            <Flag
              label="Bungie-identical"
              title="Tooltips whose English text equals Bungie's own description"
              checked={file.data.bungieIdentical}
              onChange={(value) =>
                update((current) => setData(current, key, 'bungieIdentical', value))
              }
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

function Flag({
  label,
  title,
  checked,
  onChange,
}: {
  label: string;
  title: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className={styles.check} title={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

const CategoryGroup = memo(function CategoryGroup({
  name,
  ids,
  labels,
  categories,
  sandbox,
  onToggle,
}: {
  name: string;
  ids: string[];
  labels: string[];
  categories: readonly string[];
  sandbox: readonly string[];
  onToggle(field: 'categories' | 'sandboxPerks', ids: string[], on: boolean): void;
}) {
  // Groups start closed (the Format table stays in reach); the counts say what each holds.
  const [open, setOpen] = useState(false);
  const all = (list: readonly string[]) => ids.every((id) => list.includes(id));
  const some = (list: readonly string[]) => ids.some((id) => list.includes(id));
  const count = (list: readonly string[]) => ids.filter((id) => list.includes(id)).length;
  return (
    <tbody>
      <tr className={styles.groupRow}>
        <th scope="rowgroup">
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span aria-hidden="true">{open ? '▾' : '▸'}</span> {name}
            <span
              className={styles.groupCount}
              title={`${count(categories)} of ${ids.length} chosen, ${count(sandbox)} with sandbox perks`}
            >
              {count(categories)}/{ids.length}
            </span>
          </button>
        </th>
        {(['categories', 'sandboxPerks'] as const).map((field) => {
          const list = field === 'categories' ? categories : sandbox;
          return (
            <td key={field} className={styles.checkCol}>
              <input
                type="checkbox"
                aria-label={`${field === 'categories' ? 'Tooltips' : 'Sandbox perks'}: all of ${name}`}
                checked={all(list)}
                ref={(input) => {
                  if (input) input.indeterminate = !all(list) && some(list);
                }}
                onChange={(event) => onToggle(field, ids, event.target.checked)}
              />
            </td>
          );
        })}
      </tr>
      {open &&
        ids.map((id, index) => (
          <tr key={id}>
            <th scope="row" className={styles.leaf} title={id}>
              {labels[index]}
            </th>
            {(['categories', 'sandboxPerks'] as const).map((field) => {
              const list = field === 'categories' ? categories : sandbox;
              return (
                <td key={field} className={styles.checkCol}>
                  <input
                    type="checkbox"
                    aria-label={`${field === 'categories' ? 'Tooltips' : 'Sandbox perks'}: ${labels[index]}`}
                    checked={list.includes(id)}
                    onChange={(event) => onToggle(field, [id], event.target.checked)}
                  />
                </td>
              );
            })}
          </tr>
        ))}
    </tbody>
  );
});

// Format --------------------------------------------------------------------------------------

const symbolLabels: Record<string, string> = {
  kinetic: 'Kinetic',
  arc: 'Arc',
  solar: 'Solar',
  stasis: 'Stasis',
  void: 'Void',
  strand: 'Strand',
  prismatic: 'Prismatic',
  heavy: 'Heavy ammo',
  primary: 'Primary ammo',
  special: 'Special ammo',
  barrier: 'Barrier',
  overload: 'Overload',
  unstoppable: 'Unstoppable',
  hunter: 'Hunter',
  titan: 'Titan',
  warlock: 'Warlock',
  enhancedArrow: 'Enhanced arrow',
  bold: 'Bold',
  yellow: 'Yellow',
  pve: 'PvE',
  pvp: 'PvP',
  elementText: 'Element text',
  titles: 'Titles',
  links: 'Links',
  elementTags: 'Element tags',
  spacer: 'Spacer lines',
};

function Glyph({ row }: { row: FormatRow }) {
  if (row === 'enhancedArrow') return <EnhancedArrow size="0.75rem" />;
  if (row === 'bold' || row === 'yellow' || row === 'pve' || row === 'pvp')
    return <span className={classNames([row])}>Aa</span>;
  if (row === 'elementText') return <span className={styles.glyphText}>Arc</span>;
  if ((ruleRows as readonly string[]).includes(row))
    return (
      <span className={styles.glyphText} aria-hidden="true">
        {{ titles: 'T', links: '↗', elementTags: '‹›', spacer: '¶' }[row as RuleRow]}
      </span>
    );
  return <span className={classNames([row])} />;
}

function FormatSection({
  file,
  fileKey: key,
  update,
}: {
  file: StyleFile;
  fileKey: string;
  update: Update;
}) {
  const symbolsChanged = changedRows(file, symbolIds);
  const rulesChanged = changedRows(file, ruleRows);
  const onSet = useCallback(
    (row: FormatRow, mode: string) =>
      update((current) => {
        const target = current.config.files.find(
          (candidate) => (candidate.uid ?? `new:${candidate.id}`) === key,
        );
        if (!target || isLegacyFile(target)) return current;
        return setRow(current, key, row, ruleForMode(current, target, row, mode));
      }),
    [update, key],
  );
  const onValue = useCallback(
    (row: FormatRow, value: unknown) => update((current) => setRow(current, key, row, value)),
    [update, key],
  );
  const onReset = useCallback(
    (row: FormatRow) => update((current) => resetRow(current, key, row)),
    [update, key],
  );
  const reset = (rows: FormatRow[], label = `Reset ${rows.length}`) =>
    rows.length ? (
      <button
        type="button"
        className={styles.quiet}
        onClick={() => update((current) => resetRows(current, key, rows))}
      >
        {label}
      </button>
    ) : null;
  return (
    <Section
      title="Format"
      aside={
        <span className={styles.sectionAside}>
          <span className={styles.meta}>
            {symbolsChanged.length + rulesChanged.length
              ? `${symbolsChanged.length + rulesChanged.length} changed from ${styleLabel(file.preset)}`
              : `As ${styleLabel(file.preset)}`}
          </span>
          {/* Only when both groups changed: otherwise the group's own Reset is the one. */}
          {symbolsChanged.length > 0 &&
            rulesChanged.length > 0 &&
            reset([...symbolsChanged, ...rulesChanged], 'Reset all')}
        </span>
      }
    >
      <div className={styles.symbolTable} role="table" aria-label="Symbols and rules">
        <div className={styles.symbolGroup} role="rowgroup">
          <div className={styles.groupHeading} role="row">
            <span role="columnheader">Symbols</span>
            <span className={styles.groupActions}>{reset(symbolsChanged)}</span>
          </div>
          {symbolIds.map((row) => (
            <FormatRowView
              key={row}
              row={row}
              rule={rowValue(file.format, row)}
              shape={file.shape}
              changed={rowChanged(file, row)}
              onSet={onSet}
              onValue={onValue}
              onReset={onReset}
            />
          ))}
        </div>
        <div className={styles.symbolGroup} role="rowgroup">
          <div className={styles.groupHeading} role="row">
            <span role="columnheader">Titles, links, and lines</span>
            <span className={styles.groupActions}>{reset(rulesChanged)}</span>
          </div>
          {ruleRows.map((row) => (
            <FormatRowView
              key={row}
              row={row}
              rule={rowValue(file.format, row)}
              shape={file.shape}
              changed={rowChanged(file, row)}
              onSet={onSet}
              onValue={onValue}
              onReset={onReset}
            />
          ))}
        </div>
      </div>
    </Section>
  );
}

type ModeOption = { value: string; label: string; disabled?: boolean };

function modesOf(row: FormatRow, shape: StyleFile['shape']): ModeOption[] {
  const keep = { value: 'keep', label: 'Keep', disabled: shape === 'text' };
  if (row === 'titles')
    return [keep, { value: 'drop', label: 'Drop' }, { value: 'inline', label: 'Inline' }];
  if (row === 'elementTags')
    return [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ];
  if (row === 'spacer')
    return [
      { value: 'keep', label: 'Keep' },
      { value: 'drop', label: 'Drop' },
    ];
  return [keep, { value: 'drop', label: 'Drop' }, { value: 'replace', label: 'Replace' }];
}

function currentMode(row: FormatRow, rule: unknown): string {
  if (row === 'elementTags') return rule ? 'on' : 'off';
  if (row === 'spacer') return String(rule);
  return (rule as { mode?: string } | undefined)?.mode ?? 'unset';
}

const FormatRowView = memo(function FormatRowView({
  row,
  rule,
  shape,
  changed,
  onSet,
  onValue,
  onReset,
}: {
  row: FormatRow;
  rule: unknown;
  shape: StyleFile['shape'];
  changed: boolean;
  onSet(row: FormatRow, mode: string): void;
  onValue(row: FormatRow, value: unknown): void;
  onReset(row: FormatRow): void;
}) {
  const label = symbolLabels[row] ?? row;
  const mode = currentMode(row, rule);
  const choose = (value: string) => {
    if (row === 'elementTags') onValue(row, value === 'on');
    else if (row === 'spacer') onValue(row, value);
    else onSet(row, value);
  };
  const pattern = (rule as { pattern?: string[] } | undefined)?.pattern;
  const fields: { name: string; value: string; set(value: string): unknown }[] = [];
  if (mode === 'replace' && !pattern) {
    const replace = rule as { before: string; after: string };
    fields.push(
      { name: 'Before', value: replace.before, set: (value) => ({ ...replace, before: value }) },
      { name: 'After', value: replace.after, set: (value) => ({ ...replace, after: value }) },
    );
  } else if ((mode === 'replace' || mode === 'inline') && pattern) {
    const names =
      row === 'links'
        ? ['Before text', 'After text', 'Before URL', 'After URL']
        : ['Before', 'After', 'Inner before', 'Inner after'];
    names.forEach((name, index) =>
      fields.push({
        name,
        value: pattern[index] ?? '',
        set: (value) => ({
          ...(rule as object),
          pattern: pattern.map((part, at) => (at === index ? value : part)),
        }),
      }),
    );
  }
  return (
    <div className={styles.formatRow} role="row" data-changed={changed || undefined}>
      <span className={styles.glyph} role="cell" aria-hidden="true">
        <Glyph row={row} />
      </span>
      <span className={styles.rowName} role="rowheader">
        {changed && (
          <span className={styles.changedDot} title="Changed from the style" aria-hidden="true" />
        )}
        {label}
        {changed && <span className={styles.visuallyHidden}> (changed from the style)</span>}
        {mode === 'unset' && (
          <span className={styles.meta} title="Not chosen: dropped, text kept, with a notice">
            {' '}
            not set
          </span>
        )}
      </span>
      <span className={styles.rowMode} role="cell">
        <Segmented
          label={`${label} mode`}
          value={mode === 'unset' ? 'drop' : mode}
          options={modesOf(row, shape)}
          onChange={choose}
        />
      </span>
      <span className={styles.rowState} role="cell">
        {changed ? (
          <button
            type="button"
            className={styles.reset}
            onClick={() => onReset(row)}
            aria-label={`Reset ${label} to the style's value`}
            title="Reset to the style's value"
          >
            <span aria-hidden="true">↺</span>
          </button>
        ) : null}
      </span>
      {fields.length > 0 && (
        <span className={styles.rowFields} role="cell">
          {fields.map((field) => (
            <input
              key={field.name}
              className={styles.smallField}
              value={field.value}
              maxLength={64}
              spellCheck={false}
              placeholder={field.name}
              aria-label={`${label}: ${field.name}`}
              onChange={(event) => onValue(row, field.set(event.target.value))}
            />
          ))}
        </span>
      )}
    </div>
  );
});

/** Exclusive choices as one segmented control (aria-pressed buttons), 22px inside a 28px row. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  onChange(value: T): void;
}) {
  // One tab stop per control (the pressed button); arrows move between its buttons, so Tab walks
  // the table row by row.
  const enabled = options.filter((option) => !option.disabled);
  const stop = enabled.some((option) => option.value === value) ? value : enabled[0]?.value;
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    event.preventDefault();
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };
  return (
    <span className={styles.segmented} role="group" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={option.disabled || undefined}
          tabIndex={option.value === stop ? 0 : -1}
          title={option.disabled ? 'Only the lines shape keeps symbols' : undefined}
          onClick={() => value !== option.value && onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

// Retained URLs -------------------------------------------------------------------------------

export function RetainedSection({
  state,
  maintainer,
  projectId,
  update,
}: {
  state: ProjectState;
  maintainer: boolean;
  projectId: string;
  update: Update;
}) {
  const retained = state.config.retained ?? [];
  const removedNow = state.saved.files.filter(
    (file) => file.uid && !state.config.files.some((other) => other.uid === file.uid),
  );
  if (!retained.length && !removedNow.length) return null;
  const now = Date.now();
  return (
    <Section title="Old URLs">
      <p className={styles.note}>
        A renamed, removed, or switched file keeps its old URL updating for 3 months, then it is
        frozen. Partners cannot drop these; maintainers can delete one after its window ends.
      </p>
      <ul className={styles.retained}>
        {removedNow.map((file) => (
          <li key={file.uid}>
            <span className={styles.path}>
              {projectId}/v{file.formatVersion}/{file.id}.json
            </span>
            <span className={styles.meta}>kept for 3 months after you save</span>
          </li>
        ))}
        {retained.map((entry) => {
          const ended = Date.parse(entry.until) <= now;
          return (
            <li key={entry.path}>
              <span className={styles.path}>{entry.path}</span>
              <span className={ended ? styles.warnText : styles.meta}>
                {ended ? 'frozen since ' : 'updates until '}
                <When value={entry.until} nowrap />
              </span>
              {maintainer && ended && (
                <button
                  type="button"
                  className={styles.quiet}
                  onClick={() => update((current) => removeRetained(current, entry.path))}
                >
                  Delete
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

export type { FileData };
