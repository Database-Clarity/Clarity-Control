import { memo, useMemo, useState, type ReactNode } from 'react';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { Link } from 'react-router-dom';
import type { CompendiumCell, CompendiumData } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { CompendiumDiff } from './CompendiumDiff';
import { RichCell } from './RichCell';
import { SheetCell } from './sheetSurface';
import type { CandidateBlock } from './candidateBlocks';
import { kindLabels, type QueueRow } from './queueRows';
import styles from './CompendiumTab.module.scss';

type Item = EditorData['items'][number];

interface ManifestGroup {
  names: string[];
  description: string;
  count: number;
}

/** Items that share a description collapse into one block, so six aliases read as one. */
export function manifestGroups(items: readonly Item[]): ManifestGroup[] {
  const groups = new Map<string, ManifestGroup>();
  for (const item of items) {
    const description = item.inGameDescription?.trim() ?? '';
    const group = groups.get(description) ?? { names: [], description, count: 0 };
    group.count++;
    const name = item.name || 'Unnamed item';
    if (!group.names.includes(name)) group.names.push(name);
    groups.set(description, group);
  }
  return [...groups.values()];
}

export function exoticOwners(items: readonly Item[]): string[] {
  return [
    ...new Set(
      items
        .flatMap((item) => [item.itemName, ...Object.values(item.ownerNames ?? {})])
        .filter((name): name is string => !!name),
    ),
  ];
}

function Nearby({
  block,
  source,
}: {
  block: CandidateBlock;
  source: CompendiumData;
}) {
  const [open, setOpen] = useState(false);
  const { match } = block;
  const grid = source.tabs.find((tab) => tab.gid === match.tab.gid)?.grid ?? match.tab.grid;
  const cells = useMemo(
    () =>
      open
        ? grid?.filter(
            (cell) =>
              Math.abs(cell.row - (match.row.anchor?.row ?? match.row.rowIndex)) <= 2 &&
              cell.cell.plain.trim(),
          )
        : undefined,
    [open, grid, match],
  );
  return (
    <details
      className={styles.nearby}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Nearby sheet cells · {source.fetchedAt.slice(0, 10)}</summary>
      {cells?.map((cell) => (
        <div key={`${cell.row}:${cell.col}`}>
          <small>
            R{cell.row} C{cell.col + 1}
          </small>
          <RichCell cell={cell.cell} />
        </div>
      ))}
      {open && !cells?.length && <p>No grid context available.</p>}
    </details>
  );
}

const Candidate = memo(function Candidate({
  block,
  index,
  checked,
  deferred,
  source,
  approved,
  onPick,
}: {
  block: CandidateBlock;
  index: number;
  checked: boolean;
  deferred: boolean;
  source: CompendiumData;
  /** Approval-time cell to diff against, for entries whose evidence changed. */
  approved?: CompendiumCell;
  onPick(index: number): void;
}) {
  const { location, match } = block;
  const cell = match.row.cell;
  return (
    <section
      className={styles.candidate}
      data-checked={checked || undefined}
      data-deferred={deferred || undefined}
      data-origin={block.origin}
    >
      <header>
        <label className={styles.pick} title={block.link ? 'Highlight this candidate' : undefined}>
          <input
            type="radio"
            name="candidate"
            checked={checked}
            onChange={() => onPick(index)}
            aria-label={`Candidate ${index + 1}: ${match.row.name}`}
          />
          <span className={styles.number} aria-hidden="true">
            {index + 1}
          </span>
        </label>
        <a
          className={styles.source}
          href={location.href}
          target="_blank"
          rel="noreferrer"
          title={`${location.tab}${location.section ? ` · ${location.section}` : ''}${location.range ? ` · ${location.range}` : ''}`}
        >
          <span className={styles.sourceText}>
            {location.tab}
            {location.section ? ` · ${location.section}` : ''}
          </span>
          {location.range && <span className={styles.range}> · {location.range}</span>}
          <span aria-hidden="true"> ↗</span>
          <span className="sr-only"> (opens the sheet)</span>
        </a>
      </header>
      <p className={styles.rowName}>{match.row.name}</p>
      {approved ? (
        <CompendiumDiff before={approved} after={cell} mode="changes" />
      ) : (
        <SheetCell background={cell.background}>
          <RichCell cell={cell} />
        </SheetCell>
      )}
      {block.rule && <p className={styles.rule}>{block.rule}</p>}
      {block.rationale && (
        <details className={styles.nearby}>
          <summary>Why this location?</summary>
          <p>{block.rationale}</p>
        </details>
      )}
      {index === 0 && <Nearby block={block} source={source} />}
    </section>
  );
});

/** A phone folds what the entry says now into one block the reviewer can collapse. */
function Tooltip({ phone, children }: { phone: boolean; children: ReactNode }) {
  return phone ? (
    <details className={styles.tooltip} open>
      <summary className={styles.fold}>Manifest and current tooltip</summary>
      {children}
    </details>
  ) : (
    <div className={styles.tooltip}>{children}</div>
  );
}

export interface DetailProps {
  row: QueueRow;
  categoryLabel: string;
  position?: { index: number; total: number };
  manifest: readonly Item[];
  currentText?: string;
  blocks: readonly CandidateBlock[];
  highlight: number;
  onHighlight(index: number): void;
  source: CompendiumData;
  /** Approval-time cell for changed entries (diffed against the first block). */
  approved?: CompendiumCell;
  stale?: boolean;
  /** Prev/next for phones, where the queue is behind the list button. */
  onStep?: (direction: -1 | 1) => void;
  onReinclude?: () => void;
  fromEditor?: boolean;
}

/** The selected entry: what it says now, what it could link to, and where that sits in the sheet. */
export function CompendiumDetail({
  row,
  categoryLabel,
  position,
  manifest,
  currentText,
  blocks,
  highlight,
  onHighlight,
  source,
  approved,
  stale,
  onStep,
  onReinclude,
  fromEditor,
}: DetailProps) {
  const phone = useMedia(phoneQuery);
  const groups = useMemo(() => manifestGroups(manifest), [manifest]);
  const owners = useMemo(() => exoticOwners(manifest), [manifest]);
  return (
    <section className={styles.detail} aria-label="Entry to review" data-kind={row.kind}>
      <header className={styles.identity}>
        {onStep && (
          <button
            type="button"
            className={styles.step}
            aria-label="Previous entry"
            data-perf-navigation="true"
            onClick={() => onStep(-1)}
          >
            ‹
          </button>
        )}
        {/* A paragraph with a heading role: the shared walk harness reads the first paragraph as the entry token. */}
        <p role="heading" aria-level={2} className={styles.title} title={row.name}>
          <span className={styles.category}>{categoryLabel}</span>
          <span className={styles.sep}> · </span>
          <span className={styles.entryName}>{row.name}</span>
          <span className={styles.sep}> · </span>
          <span className={styles.hash}>{row.hash}</span>
        </p>
        <span className={styles.meta}>
          <span className={styles.kindLabel} data-kind={row.kind}>
            {fromEditor ? 'From editor · ' : ''}
            {kindLabels[row.kind]}
          </span>
          {position && (
            <span
              className={styles.position}
              aria-label={`Entry ${position.index} of ${position.total}`}
            >
              {position.index} / {position.total}
            </span>
          )}
          <Link className={styles.openEditor} to={`/t/${row.hash}`}>
            Open in editor ↗
          </Link>
        </span>
        {onStep && (
          <button
            type="button"
            className={styles.step}
            aria-label="Next entry"
            data-perf-navigation="true"
            onClick={() => onStep(1)}
          >
            ›
          </button>
        )}
      </header>
      {stale && <p className={styles.warn}>Source evidence changed since this was reviewed.</p>}
      <div className={styles.columns}>
        <Tooltip phone={phone}>
          <h3>Manifest</h3>
          {groups.length ? (
            groups.map((group) => (
              <div key={group.description + group.names.join('|')} className={styles.manifest}>
                <strong>
                  {group.names.join(' / ')}
                  {group.count > 1 && <span className={styles.times}> × {group.count} items</span>}
                </strong>
                <p>{group.description || 'No manifest description available.'}</p>
              </div>
            ))
          ) : (
            <p className={styles.muted}>No manifest item available.</p>
          )}
          {owners.length > 0 && <p className={styles.muted}>Owner: {owners.join(', ')}</p>}
          <h3>Current tooltip</h3>
          <p className={styles.current}>{currentText?.trim() ? currentText : 'No text yet'}</p>
        </Tooltip>
        <div className={styles.candidates}>
          {row.kind === 'not-needed' ? (
            <div className={styles.empty}>
              <p>
                {row.excluded === 'local'
                  ? 'Marked “no equivalent” on this device.'
                  : 'Not needed by rule: this entry needs no tooltip text from the Compendium.'}
              </p>
              {onReinclude && (
                <button type="button" onClick={onReinclude}>
                  Re-include
                </button>
              )}
            </div>
          ) : (
            <>
              {row.kind === 'matched' && (
                <p className={styles.matchedNote}>Matched automatically — nothing to do.</p>
              )}
              {blocks.length ? (
                <div role="radiogroup" aria-label="Candidate sources" className={styles.blocks}>
                  {blocks.map((block, index) => (
                    <Candidate
                      key={block.id}
                      block={block}
                      index={index}
                      checked={highlight === index}
                      deferred={index > 0}
                      source={source}
                      approved={index === 0 ? approved : undefined}
                      onPick={onHighlight}
                    />
                  ))}
                </div>
              ) : (
                <p className={styles.muted}>
                  No candidate found. Use Pick row to search the sheet.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
