import type { CSSProperties } from 'react';
import { PaneDivider } from '../../ui/PaneDivider';
import { DIVIDER_TRACK, usePaneDivider } from '../../ui/usePaneDivider';
import styles from './TooltipPage.module.scss';

/**
 * The editor never gets narrower than this (design pixels); the right pane takes 320 or more of
 * what is left. Its maximum is nominal: usePaneDivider clamps to the room the editor leaves.
 */
const EDITOR_MIN = 480;
const RIGHT_MIN = 320;
const RIGHT_MAX = 8192;
const RIGHT_DEFAULT = 384;

/**
 * The editor | right pane pair (the Compendium comparison; the preview has its own column in the
 * shell). The right pane is the one sized: 320 or more, 384 by default, saved on this device as
 * `editor:right`. Where the editor cannot keep 480px beside a 320px pane the pair stacks, so the
 * editor is never squeezed: the pane follows below it. A phone has no divider at all (its panels
 * are tabs). A pane that is not there (`hasPane` false) leaves the editor the whole width.
 */
export function useWorkspaceDivider(hasPane = true, suspended = false) {
  const pane = usePaneDivider({
    storeKey: 'editor:right',
    sizes: 'end',
    min: RIGHT_MIN,
    max: RIGHT_MAX,
    reserve: EDITOR_MIN,
    defaultWidth: RIGHT_DEFAULT,
    paused: suspended,
  });
  // The limits are design pixels; the window is measured in CSS pixels at the current scale.
  const split =
    hasPane && pane.containerWidth >= (EDITOR_MIN + DIVIDER_TRACK + RIGHT_MIN) * pane.scale;
  return {
    container: pane.containerRef,
    split,
    separator: (
      <PaneDivider
        {...pane.divider}
        className={styles.divider}
        label="Resize editor and Compendium"
      />
    ),
    style: { '--right-width': `${pane.width}px` } as CSSProperties,
  };
}
