import type { Tooltip } from '@clarity/core';
import { useSettingsStore } from '../../stores/settings';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { When } from '../../ui/When';
import { CellScale } from './CompendiumDiff';
import { ScaleControl } from './ScaleControl';
import { RichCell } from './RichCell';
import { SheetCell, SheetColoursToggle } from './sheetSurface';
import { linkLocation } from './sourceLocation';
import { SourceRef } from './SourceRef';
import styles from './Compendium.module.scss';

/**
 * The translator's Compendium tab (owner 2026-11-10): READ-ONLY, and ONLY the Compendium text
 * stored with the last English save (`tooltip.compendium.snapshot`). Never the current sheet,
 * never a diff, never the matcher's candidates, and no live fallback when nothing was saved:
 * this pane fetches nothing and offers no confirm, pick, link, or match action (the Worker
 * refuses translators' Compendium writes regardless). The snapshot carries no tab name, so the
 * source link names its section and range and opens the sheet at that tab.
 */
export function SavedCompendiumPane({ base, name }: { base: Tooltip; name?: string }) {
  const scale = useSettingsStore((state) => state.device.compendiumScale);
  const link = base.compendium;
  // No source passed: the location is built from the saved link alone (no sheet load).
  const where = link ? linkLocation(link) : undefined;
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
            <p className={styles.meta}>
              <span>
                Saved with the English <When value={link.snapshotAt} />
              </span>
              <span>
                {where.section && `${where.section} · `}
                <SourceRef location={where} show="range" />
              </span>
            </p>
            <CellScale scale={scale}>
              <SheetCell background={link.snapshot.background}>
                <RichCell cell={link.snapshot} />
              </SheetCell>
            </CellScale>
          </>
        ) : (
          <p className={styles.meta}>No Compendium text was saved with the English yet</p>
        )}
      </div>
    </RightPane>
  );
}
