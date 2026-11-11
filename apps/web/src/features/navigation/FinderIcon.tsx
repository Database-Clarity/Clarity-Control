import { memo, useEffect, useState } from 'react';
import styles from './FinderPicker.module.scss';

const bungie = 'https://www.bungie.net';
/** The icon URL the preview header uses: a manifest path on bungie.net, or an https URL. */
export function finderIconUrl(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  const url = icon.startsWith('/') ? `${bungie}${icon}` : icon;
  return /^https:\/\//i.test(url) ? url : undefined;
}

/**
 * Icons that mounted in one commit get their image together, once that commit has painted: the
 * frame that opens a list draws the rows (with empty icon boxes) and never waits on image work.
 */
const waiting = new Set<() => void>();
let scheduled = false;
function afterPaint(show: () => void) {
  waiting.add(show);
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    scheduled = false;
    const all = [...waiting];
    waiting.clear();
    for (const run of all) run();
  };
  // rAF runs before the next paint; the task it queues runs after that paint.
  if (typeof requestAnimationFrame === 'function')
    requestAnimationFrame(() => setTimeout(flush, 0));
  else setTimeout(flush, 0);
}

/**
 * A row's icon in a fixed box, so rows never shift: the image arrives just after the row first
 * paints, is loaded lazily by the browser and decoded off the main thread, and is cached by
 * HTTP. Nothing waits for it; a missing or failed icon leaves the box empty. A recycled row keeps
 * its shown state, so scrolling and stepping swap the image at once.
 */
export const FinderIcon = memo(function FinderIcon({ icon }: { icon?: string }) {
  const url = finderIconUrl(icon);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (shown) return;
    let live = true;
    afterPaint(() => live && setShown(true));
    return () => {
      live = false;
    };
  }, [shown]);
  return (
    <span className={styles.icon} aria-hidden="true">
      {shown && url && (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden';
          }}
        />
      )}
    </span>
  );
});
