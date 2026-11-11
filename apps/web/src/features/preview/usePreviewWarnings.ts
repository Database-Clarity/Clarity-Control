import { useEffect, useState } from 'react';
import { usePreviewReviewStore, type ReviewEntry } from '../../stores/previewReview';

/**
 * The guard/save ledger stays immediate. The status warning gives revisions scheduled for a
 * visible render their render opportunity first. Other variants and hidden previews warn now.
 * A 250 ms watchdog also exposes a scheduled revision if the preview never commits it.
 */
export function usePreviewWarnings() {
  const entries = usePreviewReviewStore((state) => state.entries);
  const [expired, setExpired] = useState<Record<number, ReviewEntry>>({});
  useEffect(() => {
    if (!Object.values(entries).some((entry) => entry.dirty > entry.reviewed)) return;
    const timer = setTimeout(() => setExpired(entries), 250);
    return () => clearTimeout(timer);
  }, [entries]);
  return (canonical: number, scheduled: readonly number[], visible: boolean) =>
    Object.entries(entries).filter(([key, entry]) => {
      if (entry.canonical !== canonical || entry.dirty <= entry.reviewed) return false;
      const variant = Number(key);
      return !visible || !scheduled.includes(variant) || expired[variant] === entry;
    }).length;
}
