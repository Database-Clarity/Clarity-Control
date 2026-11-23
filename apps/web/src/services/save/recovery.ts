import {
  carryNumberTranslations,
  languages,
  reconcileNumberMap,
  refreshNumberFallbacks,
  stableStringify,
  type Tooltip,
} from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useAuthStore } from '../../stores/auth';
import { useDraftStore } from '../../stores/drafts';
import { applySavedOverlay, rememberSaved } from '../../stores/savedOverlay';
import { readSaveReceipts, writeSaveReceipt, type Drafts, type SaveReceipt } from '../draftStorage';
import { sessionToken } from '../session';
import {
  readCurrentSaveOutcome,
  readStagedSavedTooltips,
  resumeCurrentSave,
} from './stagedCurrentSave';
import { useSaveState } from './state';

/** Compare the whole submitted tooltip, including links and translation revision stamps. */
function sameSubmission(saved: Tooltip | undefined, sent: Tooltip): boolean {
  const withoutNumberMap = (tooltip: Tooltip) => {
    const en = tooltip.text.en;
    if (!en?.numbers) return tooltip;
    const entry = { ...en };
    delete entry.numbers;
    return { ...tooltip, text: { ...tooltip.text, en: entry } };
  };
  return (
    saved !== undefined &&
    stableStringify(withoutNumberMap(saved)) === stableStringify(withoutNumberMap(sent))
  );
}

/** Derive the server-owned number metadata and translation carry for an unchanged base. */
function expectedSubmission(base: Tooltip | null, sent: Tooltip): Tooltip {
  const next = structuredClone(sent);
  if (next.text.en && base?.text.en?.text !== next.text.en.text) {
    const numbers = reconcileNumberMap(base?.text.en, next.text.en, next);
    delete next.text.en.numbers;
    if (numbers) next.text.en.numbers = numbers;
  }
  for (const lang of languages)
    if (lang !== 'en' && next.text[lang]?.text !== base?.text[lang]?.text)
      refreshNumberFallbacks(next, lang);
  return base && base.text.en?.text !== next.text.en?.text
    ? carryNumberTranslations(base, next).tooltip
    : next;
}

/** Restore confirmed writes during bundle lag and recognise a lost response once the bundle
 * contains the submitted content. Any draft edited after sending is retained. */
export function startSaveRecovery(): () => void {
  if (typeof indexedDB === 'undefined') return () => {};
  let stopped = false;
  type Session = { generation: number; owner: string };
  let active: Session | null = null;
  let receipts: SaveReceipt[] | null = null;
  let pendingStages = new Set<string>();
  const missingSince = new Map<string, number>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const stillCurrent = (session: Session) =>
    !stopped && active === session && useDraftStore.getState().generation === session.generation;

  async function resolveStages(records: SaveReceipt[], session: Session) {
    const pending: SaveReceipt[] = [];
    const failed = new Set<string>();
    for (const [index, receipt] of records.entries()) {
      if (!stillCurrent(session)) return;
      if (!receipt.stageId || receipt.confirmed) continue;
      try {
        const result = await readCurrentSaveOutcome(receipt.stageId);
        if (!stillCurrent(session)) return;
        if (result?.status === 'queued') {
          missingSince.delete(receipt.id);
          pending.push(receipt);
        } else if (result?.status === 'saved') {
          const tooltips = await readStagedSavedTooltips(
            result.commit,
            receipt.tooltips.map(({ hash }) => hash),
          );
          if (!stillCurrent(session)) return;
          const confirmed = {
            ...receipt,
            at: Date.now(),
            confirmed: true,
            tooltips,
            savedAt: result.savedAt,
          };
          await writeSaveReceipt(session.owner, receipt.id, confirmed);
          records[index] = confirmed;
        } else if (result?.status === 'failed' || result?.status === 'conflicts') {
          failed.add(receipt.id);
          void writeSaveReceipt(session.owner, receipt.id).catch(() => {});
        } else {
          if (result?.status === 'uploading' && receipt.finalization) {
            const { token, user, loading } = useAuthStore.getState();
            if (
              !loading &&
              user?.role &&
              String(user.id) === session.owner &&
              token === sessionToken()
            )
              await resumeCurrentSave(receipt.stageId, receipt.finalization);
            pending.push(receipt);
            continue;
          }
          // Older clients wrote receipts before uploading and did not save a manifest. Give
          // a final POST already in flight time to queue before releasing an abandoned upload.
          const since = missingSince.get(receipt.id) ?? Date.now();
          if (Date.now() - since < 12_000) {
            missingSince.set(receipt.id, since);
            pending.push(receipt);
          } else {
            failed.add(receipt.id);
            void writeSaveReceipt(session.owner, receipt.id).catch(() => {});
          }
        }
      } catch {
        // Keep waiting if either the receipt or the tooltips at its commit are temporarily unreadable.
        pending.push(receipt);
      }
    }
    if (!stillCurrent(session)) return;
    pendingStages = new Set(pending.map(({ id }) => id));
    const checked = new Set(records.map(({ id }) => id));
    receipts = [
      ...(receipts ?? []).filter(({ id }) => !checked.has(id)),
      ...records.filter(({ id }) => !failed.has(id)),
    ].sort((a, b) => a.at - b.at);
    recover();
    useSaveState.setState({
      recoveryGeneration: session.generation,
      applyingDrafts: Object.assign({} as Drafts, ...pending.map((receipt) => receipt.submitted)),
    });
    if (pending.length) retry = setTimeout(() => void resolveStages(pending, session), 4000);
  }

  function recover() {
    const {
      hydrated,
      owner,
      generation: current,
      external,
      error,
      drafts,
    } = useDraftStore.getState();
    const { data } = useDataStore.getState();
    if (stopped || !hydrated || !owner || !data || useSaveState.getState().locked) return;
    if (active?.generation !== current) {
      const session = { generation: current, owner };
      active = session;
      receipts = null;
      missingSince.clear();
      clearTimeout(retry);
      void readSaveReceipts(owner)
        .then((records) => resolveStages(records, session))
        .catch(() => {
          // A failed receipt read never removes a draft.
          if (stillCurrent(session))
            useSaveState.setState({ recoveryGeneration: current, applyingDrafts: {} });
        });
      return;
    }
    if (!receipts?.length) return;

    // Work on this snapshot once. Updating the overlay or drafts can notify the subscriptions.
    const records = receipts;
    receipts = null;
    for (const receipt of records)
      if (receipt.confirmed) rememberSaved(receipt.tooltips, [], receipt.at, receipt.savedAt);
    const bundle = applySavedOverlay(data.bundle);
    if (bundle !== data.bundle) useDataStore.setState({ data: { ...data, bundle } });
    if (external || error) {
      receipts = records;
      return;
    }

    let remaining = drafts;
    for (const receipt of records) {
      if (pendingStages.has(receipt.id)) continue;
      for (const tooltip of receipt.tooltips) {
        const currentDraft = remaining[tooltip.hash];
        const submitted = receipt.submitted[tooltip.hash];
        if (
          currentDraft &&
          submitted &&
          stableStringify(currentDraft) === stableStringify(submitted) &&
          ((receipt.stageId && receipt.confirmed) ||
            sameSubmission(bundle.tooltips[tooltip.hash], tooltip) ||
            (!receipt.confirmed &&
              sameSubmission(
                bundle.tooltips[tooltip.hash],
                expectedSubmission(submitted.base, tooltip),
              )))
        ) {
          if (remaining === drafts) remaining = { ...drafts };
          delete remaining[tooltip.hash];
        }
      }
    }
    if (remaining !== drafts) {
      useDraftStore.setState({ drafts: remaining });
      useDraftStore.getState().retry();
    }
    // Keep unresolved attempts available for later static bundle refreshes.
    receipts = records.filter((record) => !record.confirmed);
  }

  const stopData = useDataStore.subscribe((value, old) => {
    if (value.data !== old.data) recover();
  });
  const stopDrafts = useDraftStore.subscribe((value, old) => {
    if (
      value.hydrated !== old.hydrated ||
      value.generation !== old.generation ||
      (old.external && !value.external) ||
      (old.error && !value.error)
    )
      recover();
  });
  const stopSave = useSaveState.subscribe((value, old) => {
    if (!value.locked && old.locked) {
      if (
        old.progress.phase === 'failed' ||
        old.progress.phase === 'landing' ||
        old.progress.phase === 'staging'
      ) {
        active = null;
        useSaveState.setState({ recoveryGeneration: null, applyingDrafts: {} });
      }
      recover();
    }
  });
  recover();
  return () => {
    stopped = true;
    clearTimeout(retry);
    stopData();
    stopDrafts();
    stopSave();
  };
}
