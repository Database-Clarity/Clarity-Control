import { SkeletonBoundary } from '../../ui/Skeleton';
// The config column (spec section 8): the file (id, style, shape), Data (category tree with
// Item hashes and Sandbox perk hashes columns, languages, files, keys, include flags), and Format
// (one 28px row per symbol and rule; changed-from-preset markers and Reset per row and section).
import { deployedLegacyPresets, legacyPresets, styleShapes, type Style } from '@clarity/export';
import {
  exportLanguages,
  fileUrls,
  isLegacyFile,
  isValidId,
  styles as styleNames,
  symbolIds,
  type ExportFile,
  type FileData,
  type ItemKey,
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
  savedFile,
  ruleRows,
  setData,
  setArrowFallback,
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
  onRenamed,
}: {
  state: ProjectState;
  file: ExportFile;
  fileKey: string;
  maintainer: boolean;
  projectId: string;
  onChange(next: (state: ProjectState) => ProjectState): void;
  onRemoved(): void;
  /** The file's new id, in the same update as the rename (the tab and URL follow it). */
  onRenamed(id: string): void;
}) {
  const update: Update = onChange;
  return (
    <div className={styles.config}>
      {/* Keyed by the tab: a pending id never carries over to another file, and a rename (which
          changes an unsaved file's key) keeps the field mounted and focused. */}
      <FileSection
        key={state.config.files.indexOf(file)}
        state={state}
        file={file}
        projectId={projectId}
        fileKey={key}
        update={update}
        onRemoved={onRemoved}
        onRenamed={onRenamed}
      />
      {isLegacyFile(file) ? (
        <>
          <LegacyNote preset={file.preset} />
          {file.preset === 'clarityV2' && (
            <Section title="Format">
              <Flag
                label="Use → instead of the arrow symbol"
                title="Exports the portable → character instead of the arrow drawing"
                checked={file.arrowFallback ?? false}
                onChange={(fallback) =>
                  update((current) => setArrowFallback(current, key, fallback))
                }
              />
            </Section>
          )}
        </>
      ) : (
        <>
          <DataSection
            file={file}
            saved={savedFile(state, file)}
            fileKey={key}
            projectId={projectId}
            update={update}
          />
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
  about,
  children,
}: {
  title: string;
  aside?: ReactNode;
  /** What this section changes in the output, in one line. */
  about?: string;
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
      {about && <p className={styles.about}>{about}</p>}
      {children}
    </section>
  );
}

// File ----------------------------------------------------------------------------------------

function FileSection({
  state,
  file,
  projectId,
  fileKey: key,
  update,
  onRemoved,
  onRenamed,
}: {
  state: ProjectState;
  file: ExportFile;
  projectId: string;
  fileKey: string;
  update: Update;
  onRemoved(): void;
  onRenamed(id: string): void;
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
    if (!idProblem && draftId !== file.id) {
      update((current) => renameFile(current, key, draftId));
      onRenamed(draftId);
    }
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
            <span id={`file-id-help-${key}`} className={styles.path}>
              {projectId}/v{file.formatVersion}/{idValue}
              {!isLegacyFile(file) && file.data.languageFiles === 'perLanguage'
                ? '/<language>'
                : ''}
              .json
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
            <span className={styles.hint}>
              {/* The style's own line describes its default shape; another shape has its own line. */}
              {file.shape === styleShapes[file.preset] && `${styleAbout[file.preset]} `}
              Switching style resets the Format rows.
            </span>
          )}
        </div>
        {!isLegacyFile(file) && (
          <>
            <span className={styles.formLabel} id={`file-shape-${key}`}>
              Shape
            </span>
            <div className={styles.formControl}>
              <Segmented
                label="Shape"
                value={file.shape}
                options={[
                  { value: 'lines', label: 'Lines' },
                  { value: 'text', label: 'Text' },
                ]}
                onChange={(shape) => update((current) => setShape(current, key, shape))}
              />
              <span className={styles.hint}>
                {file.shape === 'lines'
                  ? 'Each line is a list of parts (text, icon, link, note), so Keep can pass icons and styles to your app.'
                  : 'One string per language. Nothing can be kept as an icon or style: drop it or replace it with text.'}
              </span>
            </div>
          </>
        )}
      </div>
      <div className={styles.fileFoot}>
        <span className={styles.meta}>
          Renaming or removing a file keeps its old URL updating for 3 months, then deletes it.
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

const styleAbout: Record<Style, string> = {
  structured: 'Lines of parts: your app draws the icons, styles, notes, and links itself.',
  markdown: 'One Markdown string: **bold**, icons as words like [Arc], links as [text](url).',
  discord: 'One Markdown string without icons, for Discord messages.',
  plain: 'One plain string: text only, with → for arrows.',
};

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
  saved,
  fileKey: key,
  projectId,
  update,
}: {
  file: StyleFile;
  /** The file as last saved (none for a new file). */
  saved: ExportFile | undefined;
  fileKey: string;
  projectId: string;
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
  const perLanguage = file.data.languageFiles === 'perLanguage';
  const urls = fileUrls(projectId, file).map((url) => url.path);
  const has = (itemKey: ItemKey) => file.data.keys.includes(itemKey);
  // Language URLs the saved file has that this edit removes.
  const ending =
    perLanguage && saved && !isLegacyFile(saved) && saved.data.languageFiles === 'perLanguage'
      ? fileUrls(projectId, saved).filter((url) => !file.data.languages.includes(url.languages[0]!))
      : [];
  return (
    <Section
      title="Data"
      about="Which perks the file holds, and what each one carries. A category added later stays out until you tick it."
      aside={
        <span className={styles.meta}>
          {chosen} {chosen === 1 ? 'category' : 'categories'}, {file.data.sandboxPerks.length} with
          sandbox perks
        </span>
      }
    >
      <SkeletonBoundary pending={!categories} label="Loading categories…" shape="rows">
        <table className={styles.tree}>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col" className={styles.checkCol}>
                Item hashes
              </th>
              <th scope="col" className={styles.checkCol}>
                <span className={styles.longLabel}>Sandbox perk hashes</span>
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
      </SkeletonBoundary>
      <p className={styles.about}>
        Item hashes: the category’s perks, each under its item hash. Sandbox perk hashes: the same
        descriptions again under their sandbox perk hashes, for apps that look perks up that way.
      </p>

      <div className={styles.dataRows}>
        <div className={styles.dataRow}>
          <span className={styles.formLabel} id={`languages-${key}`}>
            Languages
          </span>
          <div className={styles.formControl}>
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
            <span className={styles.hint}>Which languages the file carries.</span>
            {ending.map((url) => (
              <span key={url.path} className={styles.warnText} role="status">
                Removing {languageLabel(url.languages[0]!)} keeps{' '}
                <span className={styles.path}>{url.path}</span> updating for 3 months after you
                save, then deletes it.
              </span>
            ))}
          </div>
        </div>
        <div className={styles.dataRow}>
          <span className={styles.formLabel} id={`language-files-${key}`}>
            Files
          </span>
          <div className={styles.formControl}>
            <Segmented
              label="Language files"
              value={file.data.languageFiles}
              options={[
                { value: 'combined', label: 'Combined' },
                { value: 'perLanguage', label: 'Per language' },
              ]}
              onChange={(mode) => update((current) => setData(current, key, 'languageFiles', mode))}
            />
            <span className={styles.hint}>
              {perLanguage ? (
                <>
                  One URL per language:{' '}
                  {urls.map((path, index) => (
                    <span key={path}>
                      {index > 0 && ', '}
                      <span className={styles.path}>
                        {index ? `…/${path.split('/').at(-1)}` : path}
                      </span>
                    </span>
                  ))}
                  . Each file is complete: a perk without a translation carries the English text.
                </>
              ) : (
                <>
                  One URL holds every chosen language:{' '}
                  <span className={styles.path}>{urls[0]}</span>. A perk without a translation
                  leaves that language out, so apps fall back to its English text.
                </>
              )}{' '}
              Switching keeps the old URLs updating for 3 months, then deletes them.
            </span>
          </div>
        </div>
        <div className={styles.dataRow}>
          <span className={styles.formLabel} id={`keys-${key}`}>
            Keys
          </span>
          <div className={styles.options} role="group" aria-labelledby={`keys-${key}`}>
            {keyRows.map((entry) => (
              <label key={entry.key} className={styles.option}>
                <input
                  type="checkbox"
                  checked={has(entry.key)}
                  onChange={(event) =>
                    update((current) =>
                      toggleData(current, key, 'keys', [entry.key], event.target.checked),
                    )
                  }
                />
                <span className={styles.optionName}>{entry.name}</span>
                <span className={styles.optionAbout}>{entry.about}</span>
              </label>
            ))}
          </div>
        </div>
        <div className={styles.dataRow}>
          <span className={styles.formLabel}>Include</span>
          <div className={styles.options}>
            <Flag
              label="Frame aliases"
              title="Weapon frames that several weapons share, each under its own hash"
              checked={file.data.frameAliases}
              onChange={(value) =>
                update((current) => setData(current, key, 'frameAliases', value))
              }
            />
            <Flag
              label="Bungie-identical"
              title="Perks whose text equals Bungie’s own description"
              checked={file.data.bungieIdentical}
              onChange={(value) =>
                update((current) => setData(current, key, 'bungieIdentical', value))
              }
            />
            <Flag
              label="Feature showcase"
              title="The built-in example as perk -1, so your app can test its rendering"
              checked={file.data.includeShowcase ?? false}
              onChange={(value) =>
                update((current) => setData(current, key, 'includeShowcase', value))
              }
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

/** The per-perk keys in the order the page lists them (defaults first), with what each holds. */
const keyRows: readonly { key: ItemKey; name: string; about: string }[] = [
  { key: 'name', name: 'name', about: 'The perk’s name, in English' },
  {
    key: 'edited',
    name: 'edited.<lang>.at',
    about: 'When each language’s text was last edited (ISO time)',
  },
  { key: 'editedBy', name: 'edited.<lang>.by', about: 'Who made that edit' },
  { key: 'itemHash', name: 'itemHash', about: 'Hash of the weapon or armor the perk belongs to' },
  { key: 'itemName', name: 'itemName', about: 'That item’s name' },
  {
    key: 'category',
    name: 'category',
    about: 'The perk’s category id, such as weapon-trait-exotic',
  },
  {
    key: 'references',
    name: 'references',
    about: 'Hashes of the perks this one refers to, when they are in this file',
  },
];

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
    <label className={styles.option}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={styles.optionName}>{label}</span>
      <span className={styles.optionAbout}>{title}</span>
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
                aria-label={`${field === 'categories' ? 'Item hashes' : 'Sandbox perk hashes'}: all of ${name}`}
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
                    aria-label={`${field === 'categories' ? 'Item hashes' : 'Sandbox perk hashes'}: ${labels[index]}`}
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
  arrow: 'Arrow',
  enhancedArrow: 'Enhanced arrow',
  bold: 'Bold',
  exotic: 'Exotic',
  pve: 'PvE',
  pvp: 'PvP',
  elementText: 'Element text',
  titles: 'Notes',
  links: 'Links',
  elementTags: 'Element tags',
  spacer: 'Spacer lines',
};

function Glyph({ row }: { row: FormatRow }) {
  if (row === 'enhancedArrow') return <EnhancedArrow size="0.75rem" />;
  if (row === 'bold' || row === 'exotic' || row === 'pve' || row === 'pvp')
    return <span className={classNames([row])}>Aa</span>;
  if (row === 'elementText') return <span className={styles.glyphText}>Arc</span>;
  if ((ruleRows as readonly string[]).includes(row))
    return (
      <span className={styles.glyphText} aria-hidden="true">
        {{ titles: 'N', links: '↗', elementTags: '‹›', spacer: '¶' }[row as RuleRow]}
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
  const iconsChanged = changedRows(file, iconRows);
  const textChanged = changedRows(file, textRows);
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
      about="How each kind of formatting reaches the file. The Feature showcase has a line for every row."
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
        {(
          [
            {
              title: 'Icons',
              rows: iconRows,
              changed: iconsChanged,
              about:
                'Keep: a part with the icon’s name, {"icon":"arc"}. Drop: nothing. Replace: your text in its place.',
            },
            {
              title: 'Text styles',
              rows: textRows,
              changed: textChanged,
              about:
                'Keep: the part lists the style, "style":["bold"] (Element text: "element":"arc"). Drop: plain text. Replace: your text before and after it.',
            },
          ] as const
        ).map((group) => (
          <div key={group.title} className={styles.symbolGroup} role="rowgroup">
            <div className={styles.groupHeading} role="row">
              <span role="columnheader">{group.title}</span>
              <span className={styles.groupAbout}>{group.about}</span>
              <span className={styles.groupActions}>{reset(group.changed)}</span>
            </div>
            {group.rows.map((row) => (
              <FormatRowView
                key={row}
                row={row}
                rule={rowValue(file.format, row, file.shape)}
                shape={file.shape}
                changed={rowChanged(file, row)}
                onSet={onSet}
                onValue={onValue}
                onReset={onReset}
              />
            ))}
          </div>
        ))}
        <div className={styles.symbolGroup} role="rowgroup">
          <div className={styles.groupHeading} role="row">
            <span role="columnheader">Notes, links, and lines</span>
            <span className={styles.groupActions}>{reset(rulesChanged)}</span>
          </div>
          {ruleRows.map((row) => (
            <FormatRowView
              key={row}
              row={row}
              rule={rowValue(file.format, row, file.shape)}
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

const textRows = ['bold', 'exotic', 'pve', 'pvp', 'elementText'] as const;
const iconRows = symbolIds.filter((row) => !(textRows as readonly string[]).includes(row));

/** What a rule row does to the output in its current mode. */
const ruleAbout: Record<RuleRow, Record<string, string>> = {
  titles: {
    keep: 'The term’s part carries its hover text as note lines.',
    drop: 'The term stays as text; its hover text goes.',
    inline: 'The hover text follows the term, wrapped in your text.',
  },
  links: {
    keep: 'The part carries the address as link.',
    drop: 'The text stays; the address goes.',
    replace: 'Text and address wrapped in your text, such as [text](url).',
  },
  elementTags: {
    off: 'Words tagged with an element export as its icon and plain text.',
    on: 'Words tagged with an element export as its icon, then text with "element":"arc" (see Element text above).',
  },
  spacer: {
    keep: 'A blank line between paragraphs stays, as a spacer line.',
    drop: 'Blank lines between paragraphs go.',
  },
};

/**
 * What a symbol row covers, for the rows whose name alone does not say it. Element, ammo,
 * champion, and class icons need no line: the name is the icon.
 */
const symbolAbout: Partial<Record<FormatRow, string>> = {
  arrow: 'The arrow between an old and a new value, as in 30%→33%.',
  enhancedArrow: 'The mark that starts a line only Enhanced perks have.',
  bold: 'Key words, and lines that are bold from start to end.',
  exotic: 'Exotic names.',
  pve: 'Values that apply in PvE, shown beside their PvP value.',
  pvp: 'Values that apply only in PvP, such as [15%].',
  elementText: 'Words tagged with an element, such as Jolt: their element tint (Element tags on).',
};

type ModeOption = { value: string; label: string; disabled?: boolean };

function modesOf(row: FormatRow, shape: StyleFile['shape']): ModeOption[] {
  const keep = { value: 'keep', label: 'Keep', disabled: shape === 'text' };
  if (row === 'titles')
    return [keep, { value: 'drop', label: 'Drop' }, { value: 'inline', label: 'Inline' }];
  if (row === 'elementTags')
    // The default (on) comes first, as in every other row.
    return [
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
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
  const about =
    mode === 'unset'
      ? 'Not chosen yet: the file drops it, keeps the text, and adds a notice.'
      : ((ruleRows as readonly string[]).includes(row)
          ? ruleAbout[row as RuleRow][mode]
          : symbolAbout[row]);
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
        {mode === 'unset' && <span className={styles.meta}> not set</span>}
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
      {about && (
        <span className={styles.rowAbout} role="cell">
          {about}
        </span>
      )}
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
        deleted. At the limit, saving asks you to confirm deletion of the oldest kept URLs.
      </p>
      <ul className={styles.retained}>
        {removedNow.map((file) => (
          <li key={file.uid}>
            <span className={styles.path}>
              {fileUrls(projectId, file)
                .map((url) => url.path)
                .join(', ')}
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
                {ended ? 'expired since ' : 'updates until '}
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
