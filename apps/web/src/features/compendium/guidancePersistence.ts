import { errorMessage } from '../../services/http';
import {
  guidanceCacheSchema,
  guidanceResponseSchema,
  type GuidanceCategory,
  type GuidanceDocument,
} from './guidanceSchema';

interface GuidanceState {
  document: GuidanceDocument;
  ready: boolean;
  saving: boolean;
  diskSaved: boolean;
  conflict: boolean;
  error: string | null;
  localError: string | null;
}
export class GuidancePersistence {
  private revision: string | null = null;
  private pending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  private state: GuidanceState;
  private readonly key: string;
  private starting?: Promise<void>;
  private recoveryError: string | null = null;

  constructor(
    scope: string,
    private readonly endpoint: string,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.key = `clarity-review-guidance:v1:${encodeURIComponent(scope)}`;
    this.state = {
      document: { version: 1, scope, baseline: '', categories: {} },
      ready: false,
      saving: false,
      diskSaved: false,
      conflict: false,
      error: null,
      localError: null,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<GuidanceState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private cache() {
    try {
      this.storage.setItem(
        this.key,
        JSON.stringify({
          document: this.state.document,
          revision: this.revision,
          pending: this.pending,
        }),
      );
      this.set({ localError: this.recoveryError });
    } catch (error) {
      this.set({
        localError: `Browser backup failed: ${errorMessage(error)}. Keep this page open until disk save succeeds.`,
      });
    }
  }
  private async disk() {
    const response = await this.request(this.endpoint, { cache: 'no-store' });
    if (!response.ok)
      throw new Error(`Guidance read HTTP ${response.status}: ${await response.text()}`);
    const result = guidanceResponseSchema.parse(await response.json());
    if (result.document && result.document.scope !== this.state.document.scope)
      throw new Error('The guidance file belongs to another dataset. It has not been overwritten.');
    return result;
  }
  start() {
    return (this.starting ??= this.open());
  }
  private async open() {
    try {
      const raw = this.storage.getItem(this.key);
      if (raw) {
        const cached = guidanceCacheSchema.parse(JSON.parse(raw));
        if (cached.document.scope !== this.state.document.scope)
          throw new Error('Backup dataset mismatch');
        this.revision = cached.revision;
        this.pending = cached.pending;
        this.set({ document: cached.document });
      }
    } catch (error) {
      this.recoveryError = `Browser backup could not be recovered: ${errorMessage(error)}`;
      this.set({ localError: this.recoveryError });
    }
    try {
      const disk = await this.disk();
      if (this.pending && this.revision !== disk.revision) {
        this.set({
          ready: true,
          conflict: true,
          error:
            'Unsaved browser guidance conflicts with disk. Export it or reload disk before continuing.',
        });
        return;
      }
      this.revision = disk.revision;
      this.set({
        ready: true,
        diskSaved: !this.pending && !!disk.document,
        document: this.pending ? this.state.document : (disk.document ?? this.state.document),
      });
      this.cache();
      if (this.pending) this.schedule();
    } catch (error) {
      this.set({
        ready: true,
        error: `Disk autosave unavailable: ${errorMessage(error)}. Comments stay in this browser; agents cannot read them yet.`,
      });
    }
  }
  synchronize(categories: Omit<GuidanceCategory, 'comment'>[], baseline: string) {
    if (!this.state.ready || this.state.conflict) return;
    const next = Object.fromEntries(
      Object.entries(this.state.document.categories).map(([id, category]) => [
        id,
        { ...category, active: false },
      ]),
    );
    for (const category of categories)
      next[category.id] = { ...category, comment: next[category.id]?.comment ?? '' };
    const document = { ...this.state.document, baseline, categories: next };
    if (JSON.stringify(document) !== JSON.stringify(this.state.document)) this.change(document);
  }
  comment(id: string, comment: string) {
    if (!this.state.ready || this.state.conflict) return;
    const category = this.state.document.categories[id];
    if (!category) throw new Error(`Unknown guidance category ${id}`);
    if (comment.length > 100_000) throw new Error('Category guidance exceeds 100,000 characters');
    this.change({
      ...this.state.document,
      categories: { ...this.state.document.categories, [id]: { ...category, comment } },
    });
  }
  private change(document: GuidanceDocument) {
    this.pending = true;
    this.set({ document, diskSaved: false });
    this.cache();
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, 400);
  }
  async flush() {
    clearTimeout(this.timer);
    if (!this.pending || this.state.saving || this.state.conflict) return;
    const document = this.state.document;
    this.set({ saving: true, error: null });
    try {
      const response = await this.request(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document, revision: this.revision }),
      });
      if (!response.ok) {
        if (response.status === 409) this.set({ conflict: true });
        throw new Error(`Guidance save HTTP ${response.status}: ${await response.text()}`);
      }
      const saved = guidanceResponseSchema.parse(await response.json());
      if (
        !saved.document ||
        JSON.stringify(saved.document) !== JSON.stringify(document) ||
        !saved.revision
      )
        throw new Error('Disk save returned an invalid acknowledgement');
      this.revision = saved.revision;
      this.pending = document !== this.state.document;
      this.set({ diskSaved: !this.pending });
      this.cache();
    } catch (error) {
      this.set({
        error: `Not saved to disk: ${errorMessage(error)}. Export or keep this browser backup; agents cannot read the latest guidance yet.`,
      });
      this.cache();
    } finally {
      this.set({ saving: false });
      if (this.pending && !this.state.error && !this.state.conflict) this.schedule();
    }
  }
  async reloadDisk() {
    if (this.state.saving) return;
    clearTimeout(this.timer);
    try {
      const disk = await this.disk();
      this.revision = disk.revision;
      this.pending = false;
      this.set({
        document: disk.document ?? { ...this.state.document, categories: {} },
        ready: true,
        conflict: false,
        error: null,
        diskSaved: !!disk.document,
      });
      this.cache();
    } catch (error) {
      this.set({
        error: `Could not reload disk; browser comments retained: ${errorMessage(error)}`,
      });
    }
  }
  dispose() {
    clearTimeout(this.timer);
    void this.flush();
  }
}
