import { exactDate, formatDate, parseDate } from '../services/format/date';
import { useSyncedSettings } from '../stores/settings';

/** Every rendered date goes through here: user format and zone, ISO kept in `dateTime`. */
export function When({
  value,
  fallback = 'unknown time',
  nowrap = false,
  nativeTitle = true,
}: {
  value: string | number | Date | null | undefined;
  fallback?: string;
  nowrap?: boolean;
  nativeTitle?: boolean;
}) {
  const settings = useSyncedSettings();
  const date = parseDate(value);
  if (!date) return <>{fallback}</>;
  // Keep the stored ISO string (with its offset) when there is one.
  const iso = typeof value === 'string' ? value : date.toISOString();
  const text = formatDate(date, settings);
  const title =
    settings.timeDisplay === 'relative'
      ? `${exactDate(date, { ...settings, timeDisplay: 'datetime' })} (${iso})`
      : iso;
  return (
    <time
      dateTime={iso}
      title={nativeTitle ? title : undefined}
      style={nowrap ? { whiteSpace: 'nowrap' } : undefined}
    >
      {text}
    </time>
  );
}
