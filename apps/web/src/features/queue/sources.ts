import { bungieDrift, type Tooltip } from '@clarity/core';
import type { User } from '../../services/api';
import type { Drafts } from '../../services/draftStorage';
import type { EditorData } from '../../stores/data';
import { isDismissed } from '../lost-text/decisions';
import type { LostText } from '../lost-text/model';
import type { QueueItem, QueueSourceId, WorkQueue } from './model';

export interface SourceContext {
  data: EditorData;
  user: User | null | undefined;
  /** Lost text's local dismissals for this account. */
  decisions: Record<string, string>;
}

export interface QueueSource {
  /** The list's name, as its tab says it: the queue control's label and its way back. */
  label: string;
  /** Where an item is worked on. */
  path(item: QueueItem): string;
  /**
   * The list's completion test, prepared once per data set: whether `item` is finished given the
   * current drafts. Called for every item on every draft change, so it must be cheap.
   */
  done(context: SourceContext): (item: QueueItem, drafts: Drafts) => boolean;
  /**
   * The list again with the queue's filters (Rebuild queue): every row it shows now, or the
   * selected ones it still shows. Items already in the queue keep their own record.
   */
  rebuild(queue: WorkQueue, context: SourceContext, drafts: Drafts): Promise<QueueItem[]>;
}

const current = (hash: number, data: EditorData, drafts: Drafts): Tooltip | undefined =>
  drafts[hash]?.next ?? data.bundle.tooltips[hash];

// ---- Bungie drift: done once the saved tooltip no longer drifts (marked reviewed, or an English
// save took a new snapshot). ----

export interface DriftRestore {
  query: string;
  selected: number[];
  scroll: number;
}

/** Whether the saved tooltip still drifts from the current in-game description. */
export function stillDrifts(hash: number, data: EditorData): boolean {
  const tooltip = data.bundle.tooltips[hash];
  return Boolean(tooltip && bungieDrift([tooltip], data.items, data.aliases).changed.length);
}

const drift: QueueSource = {
  label: 'Bungie drift',
  path: (item) => `/t/${item.hash}`,
  done({ data }) {
    const answers = new Map<number, boolean>();
    return (item) => {
      let answer = answers.get(item.hash);
      if (answer === undefined) answers.set(item.hash, (answer = !stillDrifts(item.hash, data)));
      return answer;
    };
  },
  async rebuild(queue, { data }) {
    const { driftRows, merged } = await import('./rows');
    return merged(queue, driftRows(data, (queue.origin.restore as DriftRestore).query));
  },
};

// ---- Lost text: done once the language has text again (recovered as a draft, or written) or
// the record is dismissed. ----

export interface LostRestore {
  query: string;
  classFilter: string;
  showDismissed: boolean;
  selected: string[];
  /** The record open in the list's detail, if any. */
  item: string | null;
  scroll: number;
}

const lost: QueueSource = {
  label: 'Lost text',
  path: (item) => `/t/${item.hash}?lang=${item.lang ?? 'en'}`,
  done({ data, decisions }) {
    return (item, drafts) => {
      const record = item.detail as LostText;
      const tooltip = current(item.hash, data, drafts);
      return (
        !tooltip ||
        Boolean(tooltip.text[record.lang]?.text.trim()) ||
        isDismissed(decisions, record)
      );
    };
  },
  async rebuild(queue, { data, decisions }) {
    const [{ default: artifact }, { artifactSchema }, { lostRows, lostItem, merged }] =
      await Promise.all([
        import('../lost-text/lost-text.json'),
        import('../lost-text/model'),
        import('./rows'),
      ]);
    const parsed = artifactSchema.safeParse(artifact);
    if (!parsed.success) return queue.items;
    const restore = queue.origin.restore as LostRestore;
    return merged(
      queue,
      lostRows(parsed.data.records, data, decisions, restore).map((record) =>
        lostItem(record, data),
      ),
    );
  },
};

// ---- Archive: done once an archive action is staged or saved on the item (confirmed, restored,
// or associated with a successor), compared with how it stood when the queue took it in. ----

export interface ArchiveRestore {
  returned: boolean;
  query: string;
  selected: number[];
  scroll: number;
}

/** The part of a tooltip the Archive's actions change. */
export const archiveState = (tooltip: Tooltip | undefined) =>
  !tooltip ? 'gone' : tooltip.archive ? `archived:${tooltip.archive.successor ?? ''}` : 'live';

const archive: QueueSource = {
  label: 'Archive',
  path: (item) => `/archive?item=${item.hash}`,
  done({ data }) {
    return (item, drafts) => archiveState(current(item.hash, data, drafts)) !== item.detail;
  },
  async rebuild(queue, { data }, drafts) {
    const { archiveRows, archiveItem, merged } = await import('./rows');
    return merged(
      queue,
      archiveRows(data, queue.origin.restore as ArchiveRestore).map((tooltip) =>
        archiveItem(tooltip, data, drafts),
      ),
    );
  },
};

export const queueSources: Record<QueueSourceId, QueueSource> = {
  drift,
  'lost-text': lost,
  archive,
};
