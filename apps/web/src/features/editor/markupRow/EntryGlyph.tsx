import { EnhancedArrow } from '../../../ui/EnhancedArrow';
import previewStyles from '../../preview/TooltipPreview.module.scss';
import type { EntryGlyph as Glyph } from './entries';
import styles from './MarkupRow.module.scss';

/**
 * What a markup button shows. Icons are the preview's own artwork (the same classes, so the light
 * theme's outlined copies come with them); tag colours are the game's, in both themes.
 */
export function EntryGlyph({ glyph }: { glyph: Glyph }) {
  switch (glyph.kind) {
    case 'icon':
      return (
        <span
          className={`${previewStyles[glyph.name] ?? ''} ${styles.icon}`}
          aria-hidden="true"
          data-icon={glyph.name}
        />
      );
    case 'pair':
      return (
        <span className={styles.pair}>
          <span className={styles.pve}>PvE</span>
          <span className={styles.pvp}>[PvP]</span>
        </span>
      );
    case 'base-enhanced-pair':
      // The base arm keeps the plain text colour; the enhanced arm takes the enhanced arrow's.
      return (
        <span className={styles.pair}>
          <span>B</span>
          <span aria-hidden="true">|</span>
          <span style={{ color: 'var(--enhanced)' }}>E</span>
        </span>
      );
    case 'pve':
      return <span className={styles.pve}>PvE</span>;
    case 'pvp':
      return <span className={styles.pvp}>PvP</span>;
    case 'arrow':
      return (
        <span className={glyph.text ? styles.mono : `${styles.icon} ${styles.arrow}`}>
          <EnhancedArrow />
          {glyph.text}
        </span>
      );
    case 'bold':
      return <b>B</b>;
    case 'colour':
      return <span className={styles[glyph.colour]}>Aa</span>;
    case 'mono':
      return <span className={styles.mono}>{glyph.text}</span>;
    default:
      return <span>{glyph.text}</span>;
  }
}
