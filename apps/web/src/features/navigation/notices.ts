export type NoticeLevel = 'alert' | 'warning' | 'status';

export interface NoticeAction {
  label: string;
  onClick(): void;
}

/** One condition the shell tells the user about. Built by the Layout from the stores' state. */
export interface ShellNotice {
  /** Names the condition, stable while it lasts (`draft-storage`, `data-load`). */
  id: string;
  level: NoticeLevel;
  text: string;
  /** Explicit recovery actions (Retry…); the strip never retries on its own. */
  actions?: NoticeAction[];
  /** Hover detail, e.g. the technical reason behind a sentence. */
  detail?: string;
  /** Alerts and warnings stay until dismissed or resolved; a prompt that needs an answer is not dismissible. */
  dismissible?: boolean;
  /** Called after the user dismisses it or a status fades, to clear a message a store is holding. */
  onDismiss?(): void;
  /** Not shown until the condition has lasted this long (ms), so a blink of "saving" never flashes. */
  delay?: number;
}

export const STATUS_FADE_MS = 6000;

const rank: Record<NoticeLevel, number> = { alert: 0, warning: 1, status: 2 };

/** Alert > warning > status; the order the conditions were built in is kept within a level. */
export function sortNotices(notices: ShellNotice[]): ShellNotice[] {
  return notices
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => rank[a.notice.level] - rank[b.notice.level] || a.index - b.index)
    .map(({ notice }) => notice);
}

/** "1 draft", "3 drafts". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
