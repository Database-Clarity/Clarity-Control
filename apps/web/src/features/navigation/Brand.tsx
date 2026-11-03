import { lockup } from '../../assets/brand/lockup';
import styles from './Brand.module.scss';

/**
 * The Clarity Control lockup. Both theme artworks are rendered and CSS shows the one for the
 * resolved theme (data-theme on <html>), so a theme change never reloads an image. The light
 * artwork is its own outlined drawing, not an inversion of the dark one.
 */
export function Brand({ className }: { className?: string }) {
  return (
    <div className={[styles.brand, className].filter(Boolean).join(' ')}>
      <img className={styles.dark} src={lockup.dark} alt="Clarity Control" height={20} />
      <img className={styles.light} src={lockup.light} alt="Clarity Control" height={20} />
    </div>
  );
}
