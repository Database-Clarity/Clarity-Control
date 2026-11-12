import { SkeletonBoundary } from '../../ui/Skeleton';
import type { Item } from '../../services/generator';
import { useEffect, useState } from 'react';
import { languageLabel } from '../../languageLabels';
import { languages, sameCell, type CompendiumLink, type Tooltip } from '@clarity/core';
import { CompendiumDiff } from '../compendium/CompendiumDiff';
import { SourceRef } from '../compendium/SourceRef';
import { linkLocation } from '../compendium/sourceLocation';
import { useCompendiumStore } from '../compendium/store';
import { HistoryWordDiff } from './HistoryWordDiff';
import { RenderedWordDiff } from './RenderedWordDiff';
import { useRawDiff } from './diffPreference';
import { RawDiffToggle } from './RawDiffToggle';
import renderedStyles from './RenderedWordDiff.module.scss';
import {
  attachmentCategory,
  categoryLabel,
  classifyItem,
  effectCategory,
} from '../compendium/itemClassification';
import { archiveChangeLine } from '../archive/archiveFormat';
import { useSyncedSettings } from '../../stores/settings';
import styles from './History.module.scss';

const emptyCell = { plain: '', runs: [] };
const switchable = [attachmentCategory, effectCategory];
const customText = (tooltip: Tooltip | null) => JSON.stringify(tooltip?.custom) ?? '(none)';
/**
 * Identity lines for the custom field. The friendly "Category: X → Y" line is only produced when
 * the item is known (so a missing custom has a provable native category and name) and any other
 * identity change (name) is still reported alongside it, never hidden behind it.
 */
export function identityLines(
  before: Tooltip | null,
  current: Tooltip,
  item?: Pick<Item, 'name'> & Parameters<typeof classifyItem>[0],
): string[] {
  if (JSON.stringify(before?.custom) === JSON.stringify(current.custom)) return [];
  const raw = `Custom identity: ${customText(before)} → ${customText(current)}`;
  if (!item) return [raw];
  const native = classifyItem(item)?.categoryId;
  const from = before?.custom?.categoryId ?? native,
    to = current.custom?.categoryId ?? native;
  if (!from || !to || from === to || !switchable.includes(from) || !switchable.includes(to))
    return [raw];
  const lines = [`Category: ${categoryLabel(from)} → ${categoryLabel(to)}`];
  const a = before?.custom?.name ?? item.name,
    b = current.custom?.name ?? item.name;
  if (a !== b) lines.push(`Custom identity name: ${a} → ${b}`);
  return lines;
}

export function TooltipDiff({
  before,
  current,
  item,
  raw = true,
  eagerLanguages = false,
  working = false,
  responsive = false,
}: {
  before: Tooltip | null;
  current: Tooltip;
  item?: Item;
  /** Show both full texts above the word diff; popovers show the word diff alone. */
  raw?: boolean;
  /** Bounded published snapshots render together; offscreen layout remains contained. */
  eagerLanguages?: boolean;
  /** Working panel supplies a fixed header control and saved/unsaved labels. */
  working?: boolean;
  /** Wide Working and Review containers compare side by side. History stays stacked. */
  responsive?: boolean;
}) {
  const changed = languages.filter((lang) => before?.text[lang]?.text !== current.text[lang]?.text);
  const [sourceView] = useRawDiff();
  const dateSettings = useSyncedSettings();
  const [rendered, setRendered] = useState(1);
  const busy = !raw && !eagerLanguages && rendered < changed.length;
  useEffect(() => {
    if (!busy) return;
    let timer: number | undefined;
    // Let the current language paint before activating another language's font
    // and layout. All sections remain in the DOM, and this always completes.
    const next = () => {
      timer = window.setTimeout(() => setRendered((count) => count + 1), 0);
    };
    const frame = window.requestAnimationFrame?.(next);
    if (frame === undefined) next();
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [busy, rendered]);
  return (
    <div className={styles.diff} aria-busy={busy || undefined}>
      {!working && !changed.length && <RawDiffToggle />}
      {changed.map((lang, index) => (
        <section key={lang} lang={lang} aria-label={`${languageLabel(lang)} comparison`}>
          <SkeletonBoundary
            pending={busy && index >= rendered}
            identity={`${current.hash}:${lang}`}
            label="Preparing language comparison…"
            text={current.text[lang]?.text ?? ''}
          >
            {!working && (
              <div className={renderedStyles.languageHead}>
                <h4>{languageLabel(lang)}</h4>
                <RawDiffToggle />
              </div>
            )}
            {sourceView && raw && (
              <div className={styles.columns}>
                <div>
                  <strong>{working ? 'Saved' : 'Previous / live'}</strong>
                  <pre>{before?.text[lang]?.text ?? '(not present)'}</pre>
                </div>
                <div>
                  <strong>{working ? 'Unsaved' : 'Current'}</strong>
                  <pre>{current.text[lang]?.text ?? '(not present)'}</pre>
                </div>
              </div>
            )}
            {sourceView ? (
              <HistoryWordDiff
                before={before?.text[lang]?.text ?? ''}
                after={current.text[lang]?.text ?? ''}
              />
            ) : (
              <RenderedWordDiff
                before={before?.text[lang]?.text ?? ''}
                after={current.text[lang]?.text ?? ''}
                lang={lang}
                hash={current.hash}
                working={working}
                responsive={responsive}
              />
            )}
          </SkeletonBoundary>
        </section>
      ))}
      {(before?.compendium || current.compendium) &&
        !sameSource(before?.compendium, current.compendium) && (
          <CompendiumSources before={before?.compendium} after={current.compendium} />
        )}
      {(before?.compendium || current.compendium) &&
        !sameCell(
          before?.compendium?.snapshot ?? emptyCell,
          current.compendium?.snapshot ?? emptyCell,
        ) && (
          <>
            {sameSource(before?.compendium, current.compendium) && (
              <CompendiumSources before={before?.compendium} after={current.compendium} />
            )}
            <CompendiumDiff
              before={before?.compendium?.snapshot ?? emptyCell}
              after={current.compendium?.snapshot ?? emptyCell}
            />
          </>
        )}
      {!changed.length && <p>No language text changes.</p>}
      {JSON.stringify(before?.associated ?? []) !== JSON.stringify(current.associated) && (
        <p>
          Associated tooltips: {before?.associated.join(', ') || '(none)'} →{' '}
          {current.associated.join(', ') || '(none)'}
        </p>
      )}
      {archiveChangeLine(before?.archive, current.archive, dateSettings) && (
        <p>{archiveChangeLine(before?.archive, current.archive, dateSettings)}</p>
      )}
      {identityLines(before, current, item).map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

/** The same place in the sheet: tab, row, section, anchor, and cells (labels can coincide across tabs). */
function sameSource(a?: CompendiumLink, b?: CompendiumLink) {
  if (!a || !b) return a === b;
  return (
    a.gid === b.gid &&
    // Legacy links have no anchor or cells: their row name is their place.
    a.rowKey === b.rowKey &&
    a.section === b.section &&
    JSON.stringify(a.sourceAnchor ?? null) === JSON.stringify(b.sourceAnchor ?? null) &&
    JSON.stringify(a.cells ?? null) === JSON.stringify(b.cells ?? null)
  );
}

/** Where each side's Compendium snapshot came from in the sheet (names from the loaded source only). */
function CompendiumSources({ before, after }: { before?: CompendiumLink; after?: CompendiumLink }) {
  const source = useCompendiumStore((state) => state.data);
  const from = before && linkLocation(before, source);
  const to = after && linkLocation(after, source);
  if (!from && !to) return null;
  return (
    <p className={styles.compendiumSource}>
      Compendium source:{' '}
      {from && to && !sameSource(before, after) ? (
        <>
          <SourceRef location={from} /> → <SourceRef location={to} />
        </>
      ) : (
        <SourceRef location={(to ?? from)!} />
      )}
      {from && !to && ' (link removed)'}
      {!from && to && ' (link added)'}
    </p>
  );
}
