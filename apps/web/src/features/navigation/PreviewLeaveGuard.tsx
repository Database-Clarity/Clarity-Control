import { useContext, useEffect, useState } from 'react';
import { UNSAFE_DataRouterContext, useBlocker, useLocation } from 'react-router-dom';
import { Dialog } from '../../ui/Dialog';
import dialogStyles from '../../ui/Dialog.module.scss';
import { useDataStore } from '../../stores/data';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { canonicalHash, itemFor } from './catalog';

/**
 * Leaving an item whose changes the preview has not shown yet is refused, with no way round it:
 * the prompt offers "Show preview" and "Stay", and never proceeds on its own or replays the
 * target. Once the preview has been shown with the current text, a deliberate navigation works.
 *
 * Every in-app way out goes through here: links, the finder, Back and Forward, and the route
 * blocker. Stepping asks the same store first (see stepping.ts). A browser tab close or reload
 * cannot be guarded this way; the existing draft-storage warning still applies there.
 */
export function PreviewLeaveGuard() {
  // The app always runs under a data router (main.tsx), which `useBlocker` requires. Only tests that
  // render the Layout under a declarative router lack one, and have nothing to register.
  return useContext(UNSAFE_DataRouterContext) ? <Blocking /> : null;
}

function Blocking() {
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    usePreviewReviewStore.getState().leaveBlocked(currentLocation.pathname, nextLocation.pathname),
  );
  const prompt = usePreviewReviewStore((state) => state.prompt);
  const { pathname } = useLocation();
  const data = useDataStore((state) => state.data);
  const [showAfterClose, setShowAfterClose] = useState(false);
  const open = blocker.state === 'blocked' || prompt !== null;

  useEffect(() => usePreviewReviewStore.getState().start(), []);

  // Expand and focus the column only after the dialog has closed and given focus back.
  useEffect(() => {
    if (!showAfterClose || open) return;
    setShowAfterClose(false);
    usePreviewReviewStore.getState().host?.show();
  }, [showAfterClose, open]);

  function stay() {
    if (blocker.state === 'blocked') blocker.reset();
    usePreviewReviewStore.getState().dismissPrompt();
  }

  if (!open) return null;
  const hash = Number(pathname.split('/')[2]);
  const item = prompt ?? (data && Number.isFinite(hash) ? canonicalHash(hash, data) : undefined);
  const name =
    (data && item !== undefined ? itemFor(item, data)?.name : undefined) ?? 'this tooltip';
  return (
    <Dialog
      title="Check the preview first"
      onClose={stay}
      compact
      footer={
        <>
          <button
            type="button"
            // showModal() focuses the element marked autofocus, not the header's Close button.
            ref={(button) => button?.setAttribute('autofocus', '')}
            onClick={() => {
              setShowAfterClose(true);
              stay();
            }}
          >
            Show preview<kbd className={dialogStyles.hint}>Enter</kbd>
          </button>
          <button type="button" onClick={stay}>
            Stay<kbd className={dialogStyles.hint}>Esc</kbd>
          </button>
        </>
      }
    >
      <p>
        Your changes to {name} haven&apos;t been shown in the preview yet. Show it to check them,
        then you can leave.
      </p>
      <p className={dialogStyles.caption}>Leaving is possible once the preview has been shown.</p>
    </Dialog>
  );
}
