import { useState } from 'react';
import { useDraftStore } from '../../stores/drafts';
import { useSaveNotice } from '../../services/save/notice';
import { useSettingsNotices } from '../settings/SettingsChoice';
import { useSettingsPanel } from '../settings/panel';
import { count, type ShellNotice } from './notices';

/**
 * Every condition the shell reports as an overlay notice: draft storage, adopting signed-out
 * drafts, the last save, a previous account's failure, settings sync. Loading the page's data and
 * recovering drafts are not here: they replace the page and stay in the page's own space.
 */
export function useShellNotices(): ShellNotice[] {
  const {
    hydrated,
    pending,
    error: draftError,
    previousAccountError,
    dismissPreviousAccountError,
    hydrate,
    retry,
    unowned,
    adopt,
    keepSeparate,
  } = useDraftStore();
  const [adoptNote, setAdoptNote] = useState<string | null>(null);
  const saveNotice = useSaveNotice((state) => state.notice);
  const dismissSaveNotice = useSaveNotice((state) => state.dismiss);
  const settingsOpen = useSettingsPanel((state) => state.open);
  const settings = useSettingsNotices();
  const notices: ShellNotice[] = [];

  if (draftError)
    notices.push({
      id: 'draft-storage',
      level: 'alert',
      text: draftError,
      actions: [
        { label: 'Retry draft storage', onClick: () => (hydrated ? retry() : void hydrate()) },
      ],
    });
  if (previousAccountError)
    notices.push({
      id: 'previous-account',
      level: 'alert',
      text: previousAccountError,
      onDismiss: dismissPreviousAccountError,
    });
  // Opening Settings is where a sync decision is made: do not repeat it over the dialog.
  if (!settingsOpen) notices.push(...settings);
  if (hydrated && unowned > 0)
    notices.push({
      id: 'adopt-drafts',
      level: 'warning',
      text: `${count(unowned, 'local draft')} on this browser ${unowned === 1 ? 'was' : 'were'} made while signed out or before drafts were tied to accounts. Add ${unowned === 1 ? 'it' : 'them'} to your account?`,
      // It asks a question; both answers are buttons.
      dismissible: false,
      actions: [
        {
          label: 'Add to my account',
          onClick: () =>
            void adopt().then(
              ({ adopted, left }) =>
                setAdoptNote(
                  adopted === 0
                    ? 'No drafts were added. Check draft storage and retry, or keep them separate.'
                    : `Added ${count(adopted, 'draft')} to your account.${left ? ` ${count(left, 'conflicting draft')} stayed separate.` : ''}`,
                ),
              (error: unknown) =>
                setAdoptNote(
                  `Could not add drafts: ${error instanceof Error ? error.message : String(error)}`,
                ),
            ),
        },
        { label: 'Keep separate', onClick: keepSeparate },
      ],
    });
  if (adoptNote)
    notices.push({
      id: 'adopt-result',
      level: 'status',
      text: adoptNote,
      onDismiss: () => setAdoptNote(null),
    });
  if (saveNotice)
    notices.push({
      id: 'save-result',
      level: 'status',
      text: saveNotice,
      onDismiss: dismissSaveNotice,
    });
  if (pending > 0)
    // Local writes finish in a blink while typing; only a slow one is worth saying anything about.
    notices.push({ id: 'draft-saving', level: 'status', text: 'Saving local drafts…', delay: 800 });
  return notices;
}
