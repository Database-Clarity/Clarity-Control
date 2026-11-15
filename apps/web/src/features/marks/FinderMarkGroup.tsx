import type { GroupedSection } from '../navigation/catalog';
import { FinderPicker } from '../navigation/FinderPicker';
import { markedScopeValue } from './finder';
import styles from './marks.module.scss';

/** Mark scopes live with the open entry list, so scaled headers keep their existing width. */
export function FinderMarkGroup({
  grouped,
  hash,
  group,
  all,
  choose,
}: {
  grouped: GroupedSection | undefined;
  hash: number;
  group: string;
  all: boolean;
  choose(hash: number, scope?: string | null): boolean;
}) {
  if (grouped?.grouping !== 'mark') return null;
  return (
    <FinderPicker
      label="Mark type"
      className={styles.popupPicker}
      sections={[
        {
          options: [
            { id: 'all', label: grouped.allLabel },
            ...grouped.groups.map((item) => ({ id: item.id, label: item.label })),
          ],
        },
      ]}
      value={all ? 'all' : group}
      empty="No marked entries"
      onChange={(id) => {
        if (id === 'all') choose(hash, markedScopeValue({ hash, group }, true, grouped.firstGroup));
        else {
          const first = grouped.byId.get(id)?.entries[0];
          if (first) choose(first.hash, id);
        }
      }}
    />
  );
}
