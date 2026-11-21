import { save, type Change, type SaveResult } from '../api';
import { errorMessage } from '../http';
import { useDataStore, type EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { writeSaveReceipt } from '../draftStorage';
import { newOpId } from '../publisher/ulid';
import { acceptSaved } from './drafts';
import { fitsSaveRequest, metadataOnly, saveRequestLimits } from './requestSize';
import { stageCurrentSave } from './stagedCurrentSave';
import { requestSaveChunks } from './validationWorker';
import { useSaveState, type SaveReview } from './state';

type CurrentResult = { accepted: Set<number> } & (
  | { kind: 'saved'; commit: string }
  | { kind: 'interrupted'; commit?: string }
  | { kind: 'failed'; error: string; reload?: boolean }
  | { kind: 'conflicts'; result: Extract<SaveResult, { kind: 'conflicts' }>; kept: Change[] }
);

export function saveRemainder(review: SaveReview, accepted: ReadonlySet<number>): SaveReview {
  return {
    changes: review.changes.filter(({ hash }) => !accepted.has(hash)),
    submitted: Object.fromEntries(
      Object.entries(review.submitted).filter(([hash]) => !accepted.has(Number(hash))),
    ),
  };
}

export async function saveCurrent({
  prepared,
  review,
  data,
  message,
  noTranslationImpact,
  sameSession,
  accountChanged,
}: {
  prepared: Change[];
  review: SaveReview;
  data: EditorData;
  message: string;
  noTranslationImpact: boolean;
  sameSession(): boolean;
  accountChanged(): boolean;
}): Promise<CurrentResult> {
  const accepted = new Set<number>();
  const owner = typeof indexedDB === 'undefined' ? null : useDraftStore.getState().owner;
  const previous = useSaveState.getState().progress.done;
  const total = previous + prepared.length;
  const mark = (failed: string | null = null) => {
    if (useSaveState.getState().review === review)
      useSaveState.setState({
        progress: {
          phase: failed ? 'failed' : 'saving',
          done: previous + accepted.size,
          total,
          failed,
        },
      });
  };
  const fail = (message: string, reload = false): CurrentResult => {
    const error = message.replace(/\.+$/, '');
    mark(error);
    return { kind: 'failed', accepted, error, reload };
  };

  let commit: string | undefined;
  let snapshot: EditorData | null = data;
  const stopped = (): CurrentResult | undefined => {
    if (accountChanged() || useSaveState.getState().review !== review)
      return { kind: 'interrupted', accepted, commit };
    if (!sameSession()) return fail('Your login changed. Close this review and check your role');
    if (useDraftStore.getState().external)
      return fail('Another tab changed your drafts. Choose Reload or Keep mine first');
    if (useDataStore.getState().data !== snapshot)
      return fail('The save snapshot changed. Review the current validation before saving');
  };
  mark();
  try {
    const chunks = fitsSaveRequest(prepared, message, noTranslationImpact)
      ? [prepared]
      : await requestSaveChunks(prepared, data, message, noTranslationImpact);
    while (chunks.length) {
      const chunk = chunks.shift()!;
      const stop = stopped();
      if (stop) return stop;
      const submitted = Object.fromEntries(
        chunk.flatMap(({ hash }) =>
          review.submitted[hash] ? [[hash, review.submitted[hash]]] : [],
        ),
      );
      const stageId = fitsSaveRequest(chunk, message, noTranslationImpact, saveRequestLimits.atomic)
        ? undefined
        : newOpId();
      const receipt = {
        id: owner ? crypto.randomUUID() : '',
        at: Date.now(),
        submitted,
        tooltips: chunk.map(({ next }) => next),
        confirmed: false,
        stageId,
      };
      if (owner) {
        await writeSaveReceipt(owner, receipt.id, receipt);
        const stop = stopped();
        if (stop) {
          await writeSaveReceipt(owner, receipt.id);
          return stop;
        }
      }
      const result = stageId
        ? await stageCurrentSave(
            stageId,
            chunk,
            message,
            noTranslationImpact,
            () =>
              !accountChanged() &&
              sameSession() &&
              useSaveState.getState().review === review &&
              !useDraftStore.getState().external,
            (uploaded) => {
              if (accountChanged() || useSaveState.getState().review !== review) return;
              useSaveState.setState({
                progress: {
                  phase: uploaded === null ? 'landing' : 'staging',
                  done: previous + accepted.size + (uploaded ?? chunk.length),
                  total,
                  failed: null,
                },
              });
            },
          )
        : await save(chunk, message, noTranslationImpact).catch(async (error: unknown) => {
            // A CPU-limited Worker reply has no CORS headers, so it reaches the browser as a
            // network error. Order-free metadata-only parts retry as two halves, so size never
            // fails a save. The pending receipt stays: this part may have committed.
            if (chunk.length < 2 || !chunk.every(metadataOnly) || !(error instanceof TypeError))
              throw error;
            const half = Math.ceil(chunk.length / 2);
            chunks.unshift(chunk.slice(0, half), chunk.slice(half));
            return null;
          });
      if (!result) continue;
      if (owner && result.kind !== 'saved')
        void writeSaveReceipt(owner, receipt.id).catch(() => {});
      if (accountChanged() && result.kind !== 'saved')
        return { kind: 'interrupted', accepted, commit };
      if (result.kind === 'conflicts') {
        const conflicted = new Set(result.conflicts.map(({ hash }) => hash));
        return {
          kind: 'conflicts',
          accepted,
          result,
          kept: chunk.filter(({ hash }) => !conflicted.has(hash)),
        };
      }
      if (result.kind === 'retry') return fail(result.error);
      commit = result.commit;
      const expected = new Set(chunk.map(({ hash }) => hash));
      if (
        result.tooltips.length !== expected.size ||
        result.tooltips.some(({ hash }) => !expected.delete(hash))
      ) {
        return fail(
          `Remote save ${commit} succeeded, but returned an incomplete tooltip set. Drafts are retained. Close this dialog and reload data before continuing`,
          true,
        );
      }
      try {
        if (owner)
          await writeSaveReceipt(owner, receipt.id, {
            ...receipt,
            tooltips: result.tooltips,
            savedAt: result.savedAt,
            confirmed: true,
          });
        if (accountChanged()) return { kind: 'interrupted', accepted, commit };
        const currentData = useDataStore.getState().data;
        acceptSaved(submitted, result.tooltips, commit, [], result.savedAt);
        if (currentData === snapshot) snapshot = useDataStore.getState().data;
        for (const { hash } of chunk) accepted.add(hash);
        const drafts = useDraftStore.getState();
        await drafts.flush();
        if (accountChanged()) return { kind: 'interrupted', accepted, commit };
        if (useDraftStore.getState().error)
          throw new Error('The saved result could not be reconciled with local draft storage');
      } catch (error) {
        return fail(
          `Remote save ${commit} succeeded, but local reconciliation failed. ${errorMessage(error)}. Close this dialog and reload data before continuing`,
          true,
        );
      }
      mark();
    }
    if (!commit) throw new Error('There are no changes to save.');
    return { kind: 'saved', accepted, commit };
  } catch (error) {
    return fail(errorMessage(error));
  }
}
