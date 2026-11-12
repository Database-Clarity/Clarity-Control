import type { ReportCatalogItem } from '../../../services/reports';
import styles from './ReportPage.module.scss';

export const iconUrl = (icon: string) =>
  icon.startsWith('/') ? `https://www.bungie.net${icon}` : undefined;

/** Icon, name, and "category · hash" for the item a report is about. */
export function ItemIdentity({
  item,
  category,
  hash,
}: {
  item: ReportCatalogItem;
  category: string;
  hash?: number;
}) {
  const src = iconUrl(item.icon);
  return (
    <div className={styles.item}>
      {src ? (
        <img className={styles.icon} src={src} alt="" width={36} height={36} />
      ) : (
        <span className={styles.icon} aria-hidden="true" />
      )}
      <div className={styles.itemText}>
        <h1 className={styles.itemName} title={item.name}>
          {item.name}
        </h1>
        <p className={styles.itemMeta} title={hash ? `${category} · ${hash}` : category}>
          {category}
          {hash !== undefined && <span className={styles.itemHash}> · {hash}</span>}
        </p>
      </div>
    </div>
  );
}
