import { unknownPosition, type SourceLocation } from './sourceLocation';
import styles from './SourceRef.module.scss';

// Flex items drop their edge spaces, so the separators carry non-breaking ones.
const nbsp = String.fromCharCode(160);
/** More regions than this show as the first one plus a count; the title lists them all. */
const shownRegions = 2;

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
  // A range is never cut mid-address: a long region list (multipart cards) names its first
  // region and how many follow, and the title and screen-reader text carry every region.
  const regions = range?.split(', ') ?? [];
  const compact = regions.length > shownRegions;
  const position = (
    <span className={location.unknown ? styles.unknown : styles.range}>
      {show === 'full' && `${nbsp}· `}
      {compact ? `${regions[0]} +${regions.length - 1} more` : (range ?? unknownPosition)}
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
      <span className={styles.arrow} aria-hidden="true">{`${nbsp}↗`}</span>
      <span className="sr-only">
        {show === 'full' && !compact ? '' : `, ${label}`} (opens the sheet)
      </span>
    </a>
  );
}
