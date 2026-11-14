import { useState } from 'react';
import { ReadingGlobals, ReadingTooltip } from '../preview/ReadingTooltip';
import { MarkupOnlyEnglish } from '../translations/MarkupOnlyEnglish';
import { RightPane, RightPaneHeader } from '../../ui/RightPane';
import { WordDiff } from '../../ui/diff';
import { useSettingsStore } from '../../stores/settings';
import styles from './BatchDestination.module.scss';
import {
  isMarkupOnly,
  languages,
  stableStringify,
  type Lang,
  type Tooltip,
  type MarkupGlobals,
} from '@clarity/core';
import {
  discardBatchDraft,
  draftsOfBatch,
  updateBatchDrafts,
  useBatchDraftStore,
} from '../../services/scheduled/batchDrafts';
import type { Drafts } from '../../services/draftStorage';
import { useAuthStore } from '../../stores/auth';
import { useDataStore } from '../../stores/data';
import { sessionToken } from '../../services/session';
import { prepareChanges } from '../../services/save/pipeline';
import { saveReviewToBatch } from '../review/batches/saveDestination';
import type { BatchEditing } from './batchDestination';
import { upcomingStore } from './UpcomingSwitch.store';
import { adoptBatchMembers } from './UpcomingSwitch.load';

export const subscribe = useBatchDraftStore.subscribe;
export const snapshot = useBatchDraftStore.getState;
export function drafts(source: Drafts, batchId: string): Drafts {
  return Object.fromEntries(draftsOfBatch(source, batchId));
}
export const discard = discardBatchDraft;
/** Keep the proposal as the merge base, but attribute translation text to the future English. */
export function edit(
  batchId: string,
  base: Tooltip,
  future: Tooltip,
  lang: Lang,
  text: string,
  author: string,
) {
  const auth = useAuthStore.getState();
  const local = useBatchDraftStore.getState();
  const state = upcomingStore().getState();
  const load = state.loads[batchId];
  const batch = state.memberOf[base.hash];
  if (
    !auth.user ||
    auth.loading ||
    local.owner !== String(auth.user.id) ||
    local.external ||
    state.listFailed ||
    !batch ||
    batch.id !== batchId ||
    batch.status === 'publishing' ||
    (batch.status === 'scheduled' && lang === 'en') ||
    load?.state !== 'ready' ||
    load.revision !== batch.revision ||
    stableStringify(load.upcoming.members[base.hash]?.proposed) !== stableStringify(base)
  )
    return;
  if (auth.user.role === 'translator' && (lang === 'en' || !auth.user.languages?.includes(lang)))
    return;
  if (!['maintainer', 'editor', 'translator'].includes(auth.user.role ?? '')) return;
  updateBatchDrafts(batchId, [
    {
      base,
      update: (current) => {
        const next = { ...current, text: { ...current.text } };
        if (text === (base.text[lang]?.text ?? '')) {
          if (base.text[lang]) next.text[lang] = base.text[lang];
          else delete next.text[lang];
        } else
          next.text[lang] = {
            text,
            updatedAt: new Date().toISOString(),
            updatedBy: author,
            ...(lang !== 'en' && future.text.en
              ? { sourceUpdatedAt: future.text.en.updatedAt }
              : {}),
          };
        return next;
      },
    },
  ]);
}

export async function saveBatchDrafts(batchId: string): Promise<string> {
  const auth = useAuthStore.getState();
  const user = auth.user;
  const data = useDataStore.getState().data;
  const state = upcomingStore().getState();
  const load = state.loads[batchId];
  const local = useBatchDraftStore.getState();
  if (
    !user ||
    !['maintainer', 'editor', 'translator'].includes(user.role ?? '') ||
    auth.loading ||
    !data ||
    state.listFailed ||
    load?.state !== 'ready' ||
    !local.hydrated ||
    local.owner !== String(user.id) ||
    local.external ||
    local.error
  )
    throw new Error('Reload the batch and sign in before saving. Drafts were kept.');
  const batch = Object.values(state.memberOf).find((entry) => entry.id === batchId);
  if (!batch || batch.revision !== load.revision || batch.status === 'publishing')
    throw new Error('The batch is no longer editable. Drafts were kept.');
  const sameAccount = () => {
    const current = useAuthStore.getState();
    return (
      !current.loading &&
      current.user === user &&
      current.token === auth.token &&
      sessionToken() === auth.token
    );
  };
  const tooltips = { ...data.bundle.tooltips };
  for (const [hash, draft] of Object.entries(load.upcoming.overlay)) tooltips[hash] = draft.next;
  const futureData = { ...data, bundle: { ...data.bundle, tooltips } };
  return saveReviewToBatch(
    { kind: 'batch', id: batchId },
    [],
    '',
    {},
    sameAccount,
    async (changes) => {
      const prepared = await prepareChanges(changes, user, futureData);
      return prepared.map((change, index) => {
        const authored = changes[index]!;
        const text = { ...change.next.text };
        for (const lang of languages) {
          const entry = authored.next.text[lang];
          if (
            lang === 'en' ||
            !entry ||
            entry.text === authored.base?.text[lang]?.text ||
            isMarkupOnly(authored.base?.text[lang]?.text, entry.text)
          )
            continue;
          // The revision the author actually read, even if the batch moved meanwhile.
          if (entry.sourceUpdatedAt && text[lang])
            text[lang] = { ...text[lang]!, sourceUpdatedAt: entry.sourceUpdatedAt };
        }
        return { ...change, next: { ...change.next, text } };
      });
    },
    (members) => adoptBatchMembers(batchId, members),
  );
}

export function BatchSave({ editing }: { editing: BatchEditing }) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const count = Object.keys(editing.drafts).length;
  return (
    <div className={styles.save} role="group" aria-label="Batch draft save">
      <button
        type="button"
        title={`Save drafts to ${editing.destination.batchName}`}
        aria-label={`Save drafts to ${editing.destination.batchName}`}
        disabled={pending || !!editing.reason || !count}
        onClick={async () => {
          setPending(true);
          setNotice('');
          try {
            setNotice(await saveBatchDrafts(editing.destination.batchId));
          } catch (error) {
            setNotice(error instanceof Error ? error.message : String(error));
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Saving…' : `Save batch${count ? ` (${count})` : ''}`}
      </button>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

/** Batch English only: the source preference is shared with Current's English pane. */
export function BatchEnglish({
  hash,
  current,
  upcoming,
  globals,
}: {
  hash: number;
  current: string | undefined;
  upcoming: string;
  globals: MarkupGlobals;
}) {
  const remembered = useSettingsStore((state) => state.device.remembered.englishSource);
  const fallback = useSettingsStore((state) => state.settings.englishSource);
  const remember = useSettingsStore((state) => state.remember);
  const changes = (remembered ?? fallback) === 'changes';
  return (
    <RightPane
      label="Upcoming English"
      header={
        <RightPaneHeader title="Upcoming English">
          <label className={styles.shows}>
            Shows:
            <select
              aria-label="Upcoming English shows"
              value={changes ? 'changes' : 'current'}
              onChange={(event) =>
                remember({
                  englishSource: event.target.value === 'changes' ? 'changes' : 'current',
                })
              }
            >
              <option value="changes">Changes from current</option>
              <option value="current">Upcoming English</option>
            </select>
          </label>
        </RightPaneHeader>
      }
    >
      <ReadingGlobals.Provider value={globals}>
        {!changes ? (
          <ReadingTooltip text={upcoming} hash={hash} />
        ) : current === undefined ? (
          <>
            <p>New in this batch</p>
            <ReadingTooltip text={upcoming} hash={hash} />
          </>
        ) : current === upcoming ? (
          <p>The batch does not change the English.</p>
        ) : isMarkupOnly(current, upcoming) ? (
          <MarkupOnlyEnglish before={current} current={upcoming} hash={hash} />
        ) : (
          <div aria-label="English changes in the batch">
            <WordDiff before={current} after={upcoming} />
          </div>
        )}
      </ReadingGlobals.Provider>
    </RightPane>
  );
}
