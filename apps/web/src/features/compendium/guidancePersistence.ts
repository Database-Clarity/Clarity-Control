import type { CompendiumData } from '@clarity/core';
import { notifyCompendiumInputs } from './inputEvents';
import type { ReviewCategory } from './reviewCategories';
import { rebaselineGuidance } from './rebaselineGuidance';
import { guidanceDiagnostic as errorMessage } from './guidanceDiagnostic';
import {
  guidanceCacheSchema,
  guidanceResponseSchema,
  guidanceReferenceSchema,
  guidanceSchema,
  type GuidanceCategory,
  type GuidanceDocument,
  type GuidanceReference,
} from './guidanceSchema';

interface GuidanceState {
  browserSaved: boolean;
  diskAvailable: boolean;
  document: GuidanceDocument;
  // Frozen membership/baseline from the last read, with current owner references/comments.
  planningRevision: number;
  proposalInput?: GuidanceDocument;
  ready: boolean;
  saving: boolean;
  reloading: boolean;
  diskSaved: boolean;
  conflict: boolean;
  error: string | null;
  localError: string | null;
  renewalNotice?: string;
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
  private cached?: { document: GuidanceDocument; revision: string | null; pending: boolean };
  private authoredDocument?: GuidanceDocument;
  private storedRaw?: string;
  private renewalBackup?: string;
  private pendingBackup?: string;

  constructor(
    scope: string,
    private readonly endpoint: string,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
    private readonly diskAvailable = true,
  ) {
    this.key = `clarity-review-guidance:v1:${encodeURIComponent(scope)}`;
    this.state = {
      browserSaved: false,
      diskAvailable,
      document: { version: 1, scope, baseline: '', categories: {} },
      planningRevision: 0,
      ready: false,
      saving: false,
      reloading: false,
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
    const invalidate =
      (patch.conflict === true && !this.state.conflict) || patch.reloading === true;
    this.state = {
      ...this.state,
      ...patch,
      planningRevision:
        (patch.planningRevision ?? this.state.planningRevision) + (invalidate ? 1 : 0),
    };
    for (const listener of this.listeners) listener();
  }
  private cache() {
    const document = this.authoredDocument;
    if (!document) return;
    if (
      this.cached?.document === document &&
      this.cached.revision === this.revision &&
      this.cached.pending === this.pending
    )
      return;
    try {
      if (this.pendingBackup) {
        // Preserve the original approval bytes before an explicit edit commits
        // an in-memory renewal. Opening the page never writes this backup.
        const prefix = `${this.key}:pre-renewal:`;
        let suffix = Date.now();
        while (this.storage.getItem(prefix + suffix) !== null) suffix++;
        this.storage.setItem(prefix + suffix, this.pendingBackup);
        this.pendingBackup = undefined;
      }
      const cached = {
        document,
        revision: this.revision,
        pending: this.pending,
      };
      const serialized = JSON.stringify(cached);
      if (this.storage.getItem(this.key) !== serialized) {
        this.storage.setItem(this.key, serialized);
        notifyCompendiumInputs(this.key);
      }
      // Route teardown must not stringify or rewrite an unchanged browser backup.
      this.cached = cached;
      this.storedRaw = serialized;
      this.set({ browserSaved: document === this.state.document, localError: this.recoveryError });
    } catch (error) {
      this.set({
        browserSaved: false,
        localError: `Browser backup failed: ${errorMessage(error)}. Keep this page open and export a backup.`,
      });
    }
  }
  private async disk() {
    const response = await this.request(this.endpoint, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Guidance read HTTP ${response.status}`);
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
        this.storedRaw = raw;
        const cached = guidanceCacheSchema.parse(JSON.parse(raw));
        if (cached.document.scope !== this.state.document.scope)
          throw new Error('Backup dataset mismatch');
        this.revision = cached.revision;
        this.pending = cached.pending;
        this.cached = cached;
        this.set({ document: cached.document, proposalInput: cached.document, browserSaved: true });
      }
    } catch (error) {
      this.renewalBackup ??= this.storedRaw;
      this.recoveryError = `Browser backup could not be recovered: ${errorMessage(error)}`;
      this.set({ localError: this.recoveryError });
    }
    if (!this.diskAvailable) {
      this.set({ ready: true, proposalInput: this.state.document });
      return;
    }
    try {
      const disk = await this.disk();
      if (this.pending && this.revision !== disk.revision) {
        this.set({
          ready: true,
          conflict: true,
          error:
            'Unsaved browser guidance conflicts with disk. You can keep typing locally. Export a backup before reloading disk; disk autosave is paused.',
        });
        return;
      }
      this.revision = disk.revision;
      this.set({
        ready: true,
        diskSaved: !this.pending && !!disk.document,
        document: this.pending ? this.state.document : (disk.document ?? this.state.document),
        proposalInput: this.pending ? this.state.document : (disk.document ?? undefined),
        browserSaved: this.pending && this.state.browserSaved,
      });
    } catch (error) {
      this.set({
        ready: true,
        error: `Disk autosave unavailable: ${errorMessage(error)}. Comments stay in this browser; agents cannot read them yet.`,
      });
    }
  }
  renew(categories: ReviewCategory[], source: CompendiumData, baseline: string): boolean {
    if (!this.state.ready || this.state.reloading || this.state.conflict || this.state.saving)
      return false;
    const original = this.state.document;
    if (!original.baseline || original.baseline === baseline) return true;
    const result = rebaselineGuidance(original, categories, source, baseline, original.scope);
    this.renewalBackup ??=
      this.storedRaw ??
      JSON.stringify({
        document: original,
        revision: this.revision,
        pending: this.pending,
      });
    this.change(result.document);
    this.set({
      proposalInput: result.document,
      planningRevision: this.state.planningRevision + 1,
      renewalNotice: `${result.renewed.length} references carried over, ${result.changed.length} need re-check`,
    });
    return true;
  }
  synchronize(categories: Omit<GuidanceCategory, 'comment' | 'references'>[], baseline: string) {
    if (!this.state.ready || this.state.reloading) return;
    const next = Object.fromEntries(
      Object.entries(this.state.document.categories).map(([id, category]) => [
        id,
        { ...category, active: false },
      ]),
    );
    for (const category of categories)
      next[category.id] = {
        ...next[category.id],
        ...category,
        comment: next[category.id]?.comment ?? '',
      };
    const document = { ...this.state.document, baseline, categories: next };
    if (JSON.stringify(document) !== JSON.stringify(this.state.document)) this.change(document);
  }
  comment(id: string, comment: string) {
    if (!this.state.ready) return;
    const category = this.state.document.categories[id];
    if (!category) throw new Error(`Unknown guidance category ${id}`);
    if (comment.length > 100_000) throw new Error('Category guidance exceeds 100,000 characters');
    this.change(
      {
        ...this.state.document,
        categories: { ...this.state.document.categories, [id]: { ...category, comment } },
      },
      true,
    );
  }
  reference(id: string, reference: GuidanceReference) {
    if (!this.state.ready) throw new Error('Guidance is still loading');
    const category = this.state.document.categories[id];
    if (!category) throw new Error(`Unknown guidance category ${id}`);
    const validated = guidanceReferenceSchema.parse(reference);
    if (validated.categoryId !== id || !category.hashes.includes(validated.hash))
      throw new Error('Reference must belong to this category');
    this.change(
      {
        ...this.state.document,
        categories: {
          ...this.state.document.categories,
          [id]: {
            ...category,
            references: { ...category.references, [validated.hash]: validated },
          },
        },
      },
      true,
    );
  }
  importBackup(input: unknown) {
    if (!this.state.ready || this.state.saving || this.state.reloading || this.state.conflict)
      throw new Error('Wait for guidance to load and resolve any disk conflict before importing.');
    const document = guidanceSchema.parse(input);
    if (document.scope !== this.state.document.scope)
      throw new Error('The guidance backup belongs to another dataset.');
    this.change(document, true);
    this.set({ proposalInput: document, planningRevision: this.state.planningRevision + 1 });
  }
  private change(document: GuidanceDocument, ownerEdit = false) {
    const input = this.state.proposalInput;
    const proposalInput =
      ownerEdit && input
        ? {
            ...input,
            categories: Object.fromEntries(
              Object.entries(input.categories).map(([id, category]) => [
                id,
                {
                  ...category,
                  comment: document.categories[id]?.comment ?? category.comment,
                  references: document.categories[id]?.references ?? category.references,
                },
              ]),
            ),
          }
        : input;
    this.set({
      document,
      proposalInput,
      diskSaved: false,
      browserSaved: false,
      planningRevision: this.state.planningRevision + (ownerEdit ? 1 : 0),
    });
    if (ownerEdit) this.save();
  }
  // Called only by authored decisions/comments/imports, or an explicit Send.
  save() {
    this.authorizePersistence();
    this.pending = true;
    this.cache();
    this.schedule();
  }
  private authorizePersistence() {
    this.authoredDocument = this.state.document;
    this.pendingBackup ??= this.renewalBackup;
    this.renewalBackup = undefined;
  }
  private schedule() {
    if (!this.diskAvailable) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, 400);
  }
  async flush() {
    clearTimeout(this.timer);
    if (!this.authoredDocument) return;
    if (!this.diskAvailable) {
      this.cache();
      return;
    }
    if (!this.pending || this.state.saving || this.state.conflict || this.state.reloading) return;
    const document = this.authoredDocument;
    this.set({ saving: true, error: null });
    try {
      const response = await this.request(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document, revision: this.revision }),
      });
      if (!response.ok) {
        if (response.status === 409) this.set({ conflict: true });
        throw new Error(`Guidance save HTTP ${response.status}`);
      }
      const saved = guidanceResponseSchema.parse(await response.json());
      if (
        !saved.document ||
        JSON.stringify(saved.document) !== JSON.stringify(document) ||
        !saved.revision
      )
        throw new Error('Disk save returned an invalid acknowledgement');
      this.revision = saved.revision;
      this.pending = document !== this.authoredDocument;
      this.set({ diskSaved: !this.pending && document === this.state.document });
      this.cache();
    } catch (error) {
      this.set({
        error: `Not saved to disk: ${errorMessage(error)}. You can keep editing locally. Export a backup before reloading disk; agents cannot read the latest guidance yet.`,
      });
      this.cache();
    } finally {
      this.set({ saving: false });
      if (this.pending && !this.state.error && !this.state.conflict) this.schedule();
    }
  }
  async reloadDisk() {
    if (!this.diskAvailable) return;
    if (this.state.saving || this.state.reloading) return;
    clearTimeout(this.timer);
    const document = this.state.document;
    this.set({ reloading: true });
    try {
      const disk = await this.disk();
      if (document !== this.state.document) {
        this.set({
          error:
            'Guidance changed while reloading; browser comments retained. Reload again to discard them.',
          diskSaved: false,
        });
        return;
      }
      this.revision = disk.revision;
      this.pending = false;
      this.set({
        document: disk.document ?? { ...this.state.document, categories: {} },
        proposalInput: disk.document ?? undefined,
        ready: true,
        conflict: false,
        error: null,
        diskSaved: !!disk.document,
      });
      this.authorizePersistence();
      this.cache();
    } catch (error) {
      this.set({
        error: `Could not reload disk; browser comments retained: ${errorMessage(error)}`,
      });
    } finally {
      this.set({ reloading: false });
    }
  }
  dispose() {
    clearTimeout(this.timer);
    void this.flush();
  }
}
