import { useEffect, useRef, type CSSProperties } from 'react';
import { PaneDivider } from '../../ui/PaneDivider';
import { DIVIDER_TRACK, usePaneDivider } from '../../ui/usePaneDivider';
import { layoutKey } from '../../stores/settings';
import styles from './TooltipPage.module.scss';

const MIN_PANE = 240;

/** The container must hold both minimum panes and the handle before an old percentage means anything. */
const MEASURABLE = MIN_PANE * 2 + DIVIDER_TRACK;

function readLegacySplit(): number | undefined {
  try {
    const saved = localStorage.getItem(layoutKey);
    if (saved === null || saved.trim() === '') return undefined;
    const value = Number(saved);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compatibility adapter: today's editor | preview split on the shared divider, until the editor
 * page is rebuilt around its own pair. The old single percentage is converted once, the first time
 * the container is wide enough to measure; after that only the new pixel key is read or written.
 */
export function useWorkspaceDivider() {
  const pane = usePaneDivider({
    storeKey: 'workspace:editor',
    sizes: 'start',
    min: MIN_PANE,
    max: 100_000,
    reserve: MIN_PANE,
    // The old default: an even split of the space beside the handle.
    defaultWidth: (container) => Math.max(MIN_PANE, (container - DIVIDER_TRACK) / 2),
  });
  const migrated = useRef(false);
  const { saved, containerWidth, setWidth } = pane;
  useEffect(() => {
    if (migrated.current || containerWidth < MEASURABLE) return;
    migrated.current = true;
    if (saved) return;
    const percent = readLegacySplit();
    if (percent === undefined) return;
    setWidth(((containerWidth - DIVIDER_TRACK) * percent) / 100);
    try {
      localStorage.removeItem(layoutKey);
    } catch {
      /* The old key stays; it is never read again once the new one exists. */
    }
  }, [saved, containerWidth, setWidth]);
  return {
    container: pane.containerRef,
    separator: (
      <PaneDivider {...pane.divider} className={styles.divider} label="Resize editor and preview" />
    ),
    style: { '--editor-width': `${pane.width}px` } as CSSProperties,
  };
}
