import type { CompendiumLink, Tooltip } from '@clarity/core';
import { useSettingsStore } from '../../stores/settings';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { When } from '../../ui/When';
import { CellScale } from './CompendiumDiff';
import { ScaleControl } from './ScaleControl';
import { RichCell } from './RichCell';
import { SheetCell, SheetColoursToggle } from './sheetSurface';
import { linkLocation, unknownPosition, type SourceLocation } from './sourceLocation';
import { SourceRef } from './SourceRef';
import styles from './Compendium.module.scss';

/**
 * The translator's Compendium tab (owner 2026-11-10): READ-ONLY, and ONLY the Compendium text
 * stored with the last English save (`tooltip.compendium.snapshot`). Never the current sheet,
 * never a diff, never the matcher's candidates, and no live fallback when nothing was saved:
 * this pane fetches nothing and offers no confirm, pick, link, or match action (the Worker
 * refuses translators' Compendium writes regardless).
 */
export function SavedCompendiumPane({ base, name }: { base: Tooltip; name?: string }) {
  const scale = useSettingsStore((state) => state.device.compendiumScale);
  const link = base.compendium;
  const where = link ? savedLocation(link) : undefined;
  return (
    <RightPane
      className={styles.pane}
      label={`Compendium for ${name ?? base.hash}`}
      header={
        <RightPaneHeader title="Compendium">
          {link && (
            <>
              <SheetColoursToggle />
              <ScaleControl />
            </>
          )}
        </RightPaneHeader>
      }
    >
      <div
        className={styles.zoom}
        data-scale={scale}
        data-saved-compendium={link ? 'saved' : 'none'}
      >
        {link && where ? (
          <>
            <p className={`${styles.meta} ${styles.savedMeta}`}>
              <span>
                Saved with the English <When value={link.snapshotAt} />
              </span>
              <SourceRef location={where} />
            </p>
            <CellScale scale={scale}>
              <SheetCell background={link.snapshot.background}>
                <RichCell cell={link.snapshot} />
              </SheetCell>
            </CellScale>
          </>
        ) : (
          <p className={`${styles.meta} ${styles.savedEmpty}`}>
            No Compendium text was saved with the English yet
          </p>
        )}
      </div>
    </RightPane>
  );
}

/**
 * Where the saved snapshot came from, from the saved link alone (no sheet load). The link carries
 * no tab name, so the one link reads `section · range` (`Compendium sheet · range` without a
 * section) and opens the sheet at that tab; no placeholder tab name is shown or announced.
 */
function savedLocation(link: CompendiumLink): SourceLocation {
  const { section, range, href, gid, unknown } = linkLocation(link);
  // The section is the place; a link without one names the sheet itself.
  const place = section ?? 'Compendium sheet';
  return {
    tab: place,
    range,
    unknown,
    gid,
    href,
    label: `${place} · ${range ?? unknownPosition}`,
  };
}
