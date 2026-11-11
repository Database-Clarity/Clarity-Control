import type { Lang, Tooltip } from '@clarity/core';
import { useDataStore, type EditorData } from '../../../stores/data';
import { useDraftStore } from '../../../stores/drafts';
import type { FindEntry, FindOptions, FindResult } from './index';
import { classifiedCategory } from '../../navigation/catalog';

export function entryFor(tooltip: Tooltip, data: EditorData, lang: Lang): FindEntry | undefined {
  const item =
    data.items[tooltip.hash] ?? tooltip.associated.map((hash) => data.items[hash]).find(Boolean);
  const classified = classifiedCategory(item, data);
  const categoryId =
    tooltip.custom?.categoryId ?? classified?.id ?? tooltip.archive?.lastSeen.categoryId ?? '';
  const language = tooltip.text[lang] ? lang : 'en';
  const text = tooltip.text[language]?.text;
  if (text === undefined) return;
  return {
    hash: tooltip.hash,
    name:
      tooltip.custom?.name ?? item?.name ?? tooltip.archive?.lastSeen.name ?? String(tooltip.hash),
    categoryId,
    category:
      data.categories.find((category) => category.id === categoryId)?.label ??
      classified?.label ??
      categoryId,
    lang: language,
    text,
  };
}

export interface FindResponse {
  results: FindResult[];
  capped: boolean;
}

/** Store notifications only reset a timer; snapshots, diffing, and cloning run in idle slices. */
export class FindClient {
  private worker: Worker | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stop: (() => void)[] = [];
  private generation = 0;
  private serial = 0;
  private entries = new Map<number, FindEntry>();
  private pending: { options: FindOptions; receive: (response: FindResponse) => void } | undefined;
  private receivers = new Map<number, (response: FindResponse) => void>();
  private dirty = true;
  private disposed = false;
  onError: () => void = () => undefined;
  onPending: () => void = () => undefined;

  constructor(private lang: Lang) {
    this.stop = [
      useDataStore.subscribe((state, previous) => {
        if (state.data !== previous.data) this.schedule();
      }),
      useDraftStore.subscribe((state, previous) => {
        if (state.drafts !== previous.drafts) this.schedule();
      }),
    ];
    this.schedule();
  }

  private schedule() {
    this.dirty = true;
    this.generation++;
    // A response from the previous snapshot must not resurrect stale rows.
    this.serial++;
    this.receivers.clear();
    this.onPending();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.idle(() => this.rebuild()), 350);
  }

  private idle(run: () => void) {
    const alive = () => {
      if (!this.disposed) run();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(alive, { timeout: 500 });
    else this.timer = setTimeout(alive, 0);
  }

  private rebuild() {
    if (this.disposed) return;
    try {
      if (!this.worker) {
        this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = ({ data }: MessageEvent<FindResponse & { id: number }>) => {
          const receive = this.receivers.get(data.id);
          this.receivers.delete(data.id);
          if (data.id === this.serial) receive?.(data);
        };
        this.worker.onerror = () => this.onError();
      }
      const data = useDataStore.getState().data;
      if (!data) {
        this.dirty = false;
        this.send();
        return;
      }
      const drafts = useDraftStore.getState().drafts;
      const keys = new Set([...Object.keys(data.bundle.tooltips), ...Object.keys(drafts)]);
      const iterator = keys.values();
      const seen = new Set<number>();
      const mine = this.generation;
      const slice = () => {
        if (mine !== this.generation) return;
        const batch: FindEntry[] = [];
        const until = performance.now() + 3;
        let next = iterator.next();
        while (!next.done) {
          const tooltip = drafts[next.value]?.next ?? data.bundle.tooltips[next.value];
          const entry = tooltip && entryFor(tooltip, data, this.lang);
          if (entry) {
            seen.add(entry.hash);
            const old = this.entries.get(entry.hash);
            if (
              !old ||
              old.text !== entry.text ||
              old.name !== entry.name ||
              old.categoryId !== entry.categoryId ||
              old.lang !== entry.lang
            ) {
              batch.push(entry);
              this.entries.set(entry.hash, entry);
            }
          }
          if (performance.now() >= until) break;
          next = iterator.next();
        }
        this.worker!.postMessage({ type: 'update', entries: batch, removed: [] });
        if (!next.done) this.idle(slice);
        else {
          const removed = [...this.entries.keys()].filter((hash) => !seen.has(hash));
          for (const hash of removed) this.entries.delete(hash);
          this.worker!.postMessage({ type: 'update', entries: [], removed });
          this.dirty = false;
          this.send();
        }
      };
      slice();
    } catch {
      this.onError();
    }
  }

  query(options: FindOptions, receive: (response: FindResponse) => void) {
    this.pending = { options, receive };
    this.serial++;
    this.receivers.clear();
    if (!this.dirty) this.send();
  }

  private send() {
    if (!this.pending || !this.worker) return;
    const { options, receive } = this.pending;
    const id = ++this.serial;
    this.receivers.set(id, receive);
    this.worker.postMessage({ type: 'query', id, options });
  }

  destroy() {
    this.disposed = true;
    for (const stop of this.stop) stop();
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.receivers.clear();
  }
}
