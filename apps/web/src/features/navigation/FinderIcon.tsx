import { memo } from 'react';
import styles from './FinderPicker.module.scss';

const bungie = 'https://www.bungie.net';
/** The icon URL the preview header uses: a manifest path on bungie.net, or an https URL. */
export function finderIconUrl(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  const url = icon.startsWith('/') ? `${bungie}${icon}` : icon;
  return /^https:\/\//i.test(url) ? url : undefined;
}

/**
 * A row's icon in a fixed box, so rows never shift: loaded lazily by the browser (only rendered
 * rows have one), decoded off the main thread, cached by HTTP. Nothing waits for it; a missing or
 * failed icon leaves the box empty.
 */
export const FinderIcon = memo(function FinderIcon({ icon }: { icon?: string }) {
  const url = finderIconUrl(icon);
  return (
    <span className={styles.icon} aria-hidden="true">
      {url && (
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
