import { useLocation, useNavigate } from 'react-router-dom';
import { useMemo } from 'react';
import type { EditorData } from '../../stores/data';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { tooltipPath } from '../navigation/stepping';
import type { WorkQueue } from '../queue/model';
import { startQueue } from '../queue/start';
import { markTypeFromGroup } from './finder';
import { useMarksStore } from './store';
import { markedQueueItems } from './source';
import styles from './marks.module.scss';

export function useMarkedQueueBits(queue: WorkQueue | undefined): string {
  const marks = useMarksStore((state) => state.marks);
  const items = queue?.items;
  const source = queue?.source;
  return useMemo(
    () =>
      source === 'marks'
        ? items!
            .map((item) =>
              marks.entries[item.hash]?.some((mark) => mark.type === item.detail) ? '0' : '1',
            )
            .join('')
        : '',
    [marks, items, source],
  );
}
export function MarkedWorkThrough({
  data,
  group,
  all,
  query,
  onStart,
}: {
  data: EditorData;
  group: string;
  all: boolean;
  query: string;
  onStart?: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const type = markTypeFromGroup(group);
  if (!type || all) return null;
  return (
    <button
      type="button"
      aria-label="Work through marked entries"
      onMouseDown={(event) => event.preventDefault()}
      className={styles.queueButton}
      onClick={() => {
        const items = markedQueueItems(data, type, location.search, query);
        const first = items[0];
        if (!first) return;
        first.path = tooltipPath(first.hash, location.search, group);
        if (
          !usePreviewReviewStore
            .getState()
            .requestLeave(location.pathname, first.path.split('?')[0])
        )
          return;
        const target = startQueue({
          source: 'marks',
          scope: 'shown',
          items,
          first,
          origin: {
            path: location.pathname + location.search,
            restore: { type, search: location.search, query },
          },
          focus: true,
        });
        navigate(target.to, { state: target.state });
        onStart?.();
      }}
    >
      Work through
    </button>
  );
}
