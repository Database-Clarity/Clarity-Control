import {
  carryNumberTranslations,
  languages,
  reconcileNumberMap,
  refreshNumberFallbacks,
  stableStringify,
  type Tooltip,
} from '@clarity/core';
import { useDataStore } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { applySavedOverlay, rememberSaved } from '../../stores/savedOverlay';
import {
  readSaveReceipts,
  sameDraftContent,
  writeSaveReceipt,
  type SaveReceipt,
} from '../draftStorage';
import { readCurrentSaveOutcome, readStagedSavedTooltips } from './stagedCurrentSave';
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
export function expectedSubmission(base: Tooltip | null, sent: Tooltip): Tooltip {
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
  let generation = -1;
  let receipts: SaveReceipt[] | null = null;

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
    if (generation !== current) {
      generation = current;
      receipts = null;
      void readSaveReceipts(owner)
        .then(async (records) => {
          const stillCurrent = () => !stopped && useDraftStore.getState().generation === current;
          for (const [index, receipt] of records.entries()) {
            if (!stillCurrent()) return;
            if (!receipt.stageId || receipt.confirmed) continue;
            try {
              const result = await readCurrentSaveOutcome(receipt.stageId);
              if (!stillCurrent()) return;
              if (result.status !== 'saved') continue;
              const tooltips = await readStagedSavedTooltips(
                result.commit,
                receipt.tooltips.map(({ hash }) => hash),
              );
              if (!stillCurrent()) return;
              const confirmed = { ...receipt, confirmed: true, tooltips, savedAt: result.savedAt };
              await writeSaveReceipt(owner, receipt.id, confirmed);
              records[index] = confirmed;
            } catch {
              // The next bundle can confirm the original attempt when status or raw is unavailable.
            }
          }
          if (stopped || useDraftStore.getState().generation !== current) return;
          receipts = records.sort((a, b) => a.at - b.at);
          recover();
        })
        .catch(() => {
          // A failed receipt read never removes a draft.
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
      for (const tooltip of receipt.tooltips) {
        const currentDraft = remaining[tooltip.hash];
        const submitted = receipt.submitted[tooltip.hash];
        if (
          currentDraft &&
          submitted &&
          sameDraftContent(currentDraft, submitted) &&
          (sameSubmission(bundle.tooltips[tooltip.hash], tooltip) ||
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
    if (!value.locked && old.locked) recover();
  });
  recover();
  return () => {
    stopped = true;
    stopData();
    stopDrafts();
    stopSave();
  };
}
