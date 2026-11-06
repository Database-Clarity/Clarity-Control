import { lockup, mark } from '../../assets/brand/lockup';
import styles from './Brand.module.scss';

/**
 * The Clarity Control lockup. Both theme artworks are rendered and CSS shows the one for the
 * resolved theme (data-theme on <html>), so a theme change never reloads an image. The light
 * artwork is its own outlined drawing, not an inversion of the dark one.
 */
export function Brand({ className, compact = false }: { className?: string; compact?: boolean }) {
  // Compact windows (< 1100px) and bars too tight for the finder keep the mark alone; the full
  // lockup returns as soon as the bar has room (Header decides, from its measured width).
  if (compact)
    return (
      <div
        className={[styles.brand, className].filter(Boolean).join(' ')}
        role="img"
        aria-label="Clarity Control"
      >
        <BrandMark />
      </div>
    );
  return (
    <div className={[styles.brand, className].filter(Boolean).join(' ')}>
      <img className={styles.dark} src={lockup.dark} alt="Clarity Control" height={28} />
      <img className={styles.light} src={lockup.light} alt="Clarity Control" height={28} />
    </div>
  );
}

/** The mark alone, for the phone header's workspaces button. Decorative: its button names it. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={[styles.mark, className].filter(Boolean).join(' ')} aria-hidden="true">
      <img className={styles.dark} src={mark.dark} alt="" />
      <img className={styles.light} src={mark.light} alt="" />
    </span>
  );
}
