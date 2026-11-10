import { unknownPosition, type SourceLocation } from './sourceLocation';
import styles from './SourceRef.module.scss';

/**
 * Where Compendium content sits in the sheet, as a link opening the sheet itself at that tab and
 * range: `Armor Mods · Raid Specific · C12:E14 ↗`. Narrow rows show the tab only (`show="tab"`) and
 * cell lists the range only (`show="range"`); the full label stays in the title. The tab and section
 * shrink with an ellipsis before the range does.
 */
export function SourceRef({
  location,
  show = 'full',
  block = false,
}: {
  location: SourceLocation;
  show?: 'full' | 'tab' | 'range';
  /** Its own line under a notice, never run into the sentence. */
  block?: boolean;
}) {
  const { tab, section, range, href, label } = location;
  const position = (
    <span className={location.unknown ? styles.unknown : styles.range}>
      {show === 'full' && ' · '}
      {range ?? unknownPosition}
    </span>
  );
  return (
    <a
      className={block ? `${styles.ref} ${styles.block}` : styles.ref}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open in the sheet: ${label}`}
      data-source-ref=""
    >
      {show !== 'range' && (
        <span className={styles.place}>
          {tab}
          {show === 'full' && section ? ` · ${section}` : ''}
        </span>
      )}
      {show !== 'tab' && position}
      <span aria-hidden="true"> ↗</span>
      <span className="sr-only">{show === 'full' ? '' : `, ${label}`} (opens the sheet)</span>
    </a>
  );
}
