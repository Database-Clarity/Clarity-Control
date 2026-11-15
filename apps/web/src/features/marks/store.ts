import { create } from 'zustand';
import { z } from 'zod';
import {
  emptyMarks,
  marksSchema,
  marksRevisionSchema,
  type Marks,
  type MarkAction,
  type EntryMark,
  type MarkType,
} from '@clarity/core/marks';
import { apiRequest } from '../../services/api';
import { fetchOptionalJson, errorMessage } from '../../services/http';
import { useAuthStore } from '../../stores/auth';

export const marksUrl =
  'https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/editor-data/config/marks.json';
const loadedSchema = z.object({ marks: marksSchema, revision: marksRevisionSchema });
export interface MarkDisplay extends EntryMark {
  label: string;
  colour: MarkType['colour'];
}
export const noEntryMarks: readonly MarkDisplay[] = [];
export function indexMarks(marks: Marks): ReadonlyMap<number, readonly MarkDisplay[]> {
  const types = new Map(marks.types.map((type) => [type.id, type]));
  return new Map(
    Object.entries(marks.entries).map(([hash, entries]) => [
      Number(hash),
      entries.map((entry) => {
        const type = types.get(entry.type)!;
        return { ...entry, label: type.label, colour: type.colour };
      }),
    ]),
  );
}
interface MarksState {
  marks: Marks;
  index: ReturnType<typeof indexMarks>;
  revision: string | null;
  writable: boolean;
  saving: boolean;
  error: string | null;
  accept(marks: Marks, revision?: string | null): void;
  load(): Promise<void>;
  reload(): Promise<void>;
  save(change: MarkAction): Promise<void>;
}
let rawRequest: Promise<void> | undefined;
let requestVersion = 0;
async function checked(response: Response) {
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `HTTP ${response.status}`);
  }
  const parsed = loadedSchema.safeParse(await response.json());
  if (!parsed.success)
    throw new Error('Invalid config/marks.json; marks are read-only until repaired');
  return parsed.data;
}
export const useMarksStore = create<MarksState>((set, get) => ({
  marks: emptyMarks(),
  index: new Map(),
  revision: null,
  writable: false,
  saving: false,
  error: null,
  accept(marks, revision) {
    set({
      marks,
      index: indexMarks(marks),
      revision: revision ?? null,
      writable: revision !== undefined,
      error: null,
    });
  },
  load() {
    rawRequest ??= (async () => {
      const version = ++requestVersion;
      try {
        const marks = await fetchOptionalJson(`${marksUrl}?at=${Date.now()}`, marksSchema, {
          cache: 'no-store',
        });
        if (version === requestVersion) get().accept(marks ?? emptyMarks());
      } catch (error) {
        if (version === requestVersion)
          set({
            writable: false,
            error:
              error instanceof z.ZodError
                ? 'Invalid config/marks.json; marks are read-only until repaired.'
                : `Marks unavailable; read-only. ${errorMessage(error)} Reload the page to retry.`,
          });
      }
    })();
    return rawRequest;
  },
  async reload() {
    if (get().saving) return;
    const version = ++requestVersion;
    const identity = useAuthStore.getState();
    set({ writable: false });
    try {
      const value = await checked(await apiRequest('/marks'));
      const current = useAuthStore.getState();
      if (
        version !== requestVersion ||
        current.user !== identity.user ||
        current.token !== identity.token
      )
        return;
      get().accept(value.marks, value.revision);
    } catch (error) {
      if (version === requestVersion)
        set({ writable: false, error: `Marks unavailable; read-only. ${errorMessage(error)}` });
    }
  },
  async save(change) {
    if (!get().writable) throw new Error('Reload marks before saving');
    const identity = useAuthStore.getState();
    const version = ++requestVersion;
    set({ saving: true, writable: false });
    try {
      const value = await checked(
        await apiRequest('/marks', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revision: get().revision, change }),
        }),
      );
      const current = useAuthStore.getState();
      if (
        version !== requestVersion ||
        current.user !== identity.user ||
        current.token !== identity.token
      )
        return;
      get().accept(value.marks, value.revision);
    } catch (error) {
      if (version === requestVersion) set({ writable: false, error: errorMessage(error) });
      throw error;
    } finally {
      set({ saving: false });
    }
  },
}));
