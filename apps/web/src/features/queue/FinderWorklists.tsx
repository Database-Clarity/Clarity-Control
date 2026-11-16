import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { usePreviewReviewStore } from '../../stores/previewReview';
import type { WorklistEntry } from '../../../../../packages/core/src/worklists';
import { FinderSheetCloseContext } from '../navigation/FinderSheetContext';
import { afterPaint } from '../navigation/FinderIcon';
import { DraftWorklistsPanel, WorklistPicker } from './WorklistsMenu';
import type { DraftGroup } from './savedSources';
import { startQueue } from './start';
import { queueSources } from './sources';
import styles from './FinderWorklists.module.scss';

interface Selection {
  selecting: boolean;
  selected: WorklistEntry[];
  choosing: WorklistEntry[] | null;
}
export type FinderWorklistController = StoreApi<Selection>;
const initial = (): Selection => ({
  selecting: false,
  selected: [],
  choosing: null,
});
interface WorklistsContext {
  controller: FinderWorklistController;
  selection: Selection;
  user: boolean;
}
const Context = createContext<WorklistsContext | null>(null);
export function useFinderWorklists(open: boolean): FinderWorklistController {
  const controller = useMemo(() => createStore<Selection>(initial), []);
  useEffect(() => {
    if (!open) controller.setState(initial());
  }, [controller, open]);
  return controller;
}
function toggle(controller: FinderWorklistController, item: WorklistEntry) {
  controller.setState((state) => ({
    selecting: true,
    selected: state.selected.some((old) => old.hash === item.hash)
      ? state.selected.filter((old) => old.hash !== item.hash)
      : [...state.selected, item],
  }));
}
/** These shortcuts belong only to the open finder, and never step or commit a row. */
export function finderWorklistKey(
  event: KeyboardEvent<HTMLInputElement>,
  controller: FinderWorklistController,
  open: boolean,
  row?: { hash: number; name: string; entry?: string; global?: unknown },
): boolean {
  if (!open || !(event.ctrlKey || event.metaKey) || !useAuthStore.getState().user) return false;
  if (controller.getState().choosing && (event.key === ' ' || event.key === 'Enter')) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  const item = row && !row.global ? { hash: row.hash, name: row.entry ?? row.name } : undefined;
  if (event.key === ' ' && item) {
    event.preventDefault();
    event.stopPropagation();
    toggle(controller, item);
    return true;
  }
  if (event.key === 'Enter') {
    const selected = controller.getState().selected;
    const items = selected.length ? selected : item ? [item] : [];
    if (!items.length) return false;
    event.preventDefault();
    event.stopPropagation();
    controller.setState({ choosing: items });
    return true;
  }
  return false;
}
/** The only finder container change: keep all picker UI inside the existing blur boundary. */
export function FinderWorklistScope({
  controller,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  controller: FinderWorklistController;
  children: ReactNode;
}) {
  // Rows need no subscriptions. One boundary owns selection updates, and rows render their
  // checkbox only after the user enters worklist selection mode.
  const selection = useStore(controller);
  const user = useAuthStore((state) => Boolean(state.user));
  const value = useMemo(() => ({ controller, selection, user }), [controller, selection, user]);
  const selecting = user && selection.selecting;
  return (
    <Context.Provider value={value}>
      <div
        {...props}
        onClickCapture={(event) => {
          // While selecting, a click anywhere on a row toggles it instead of opening the entry.
          if (!selecting || selection.choosing) return;
          const target = event.target as Element;
          const box = target
            .closest('[role="option"]')
            ?.querySelector<HTMLInputElement>('input[data-worklist-check]');
          if (!box || target === box) return;
          event.preventDefault();
          event.stopPropagation();
          box.click();
        }}
      >
        <FinderWorklistBar />
        {children}
      </div>
    </Context.Provider>
  );
}
export function FinderWorklistRow({
  hash,
  name,
  global,
  children,
}: {
  hash: number;
  name: string;
  global?: boolean;
  children: ReactNode;
}) {
  const { controller, selection, user } = useContext(Context)!;
  if (global || !user || !selection.selecting) return children;
  const selected = selection.selected.some((item) => item.hash === hash);
  return (
    // While selecting, the checkbox takes the row icon's place: the row keeps its width.
    <span className={styles.row}>
      <input
        type="checkbox"
        data-worklist-check=""
        tabIndex={-1}
        className={styles.check}
        checked={selected}
        disabled={selection.choosing !== null}
        aria-label={`Select ${name} for worklist`}
        title="Select for worklist (Ctrl+Space)"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => event.stopPropagation()}
        onChange={() => toggle(controller, { hash, name })}
      />
    </span>
  );
}
function FinderWorklistBar() {
  const { controller, selection, user } = useContext(Context)!;
  const { choosing } = selection;
  const selecting = user && selection.selecting;
  const count = selection.selected.length;
  const host = useRef<HTMLDivElement>(null);
  // The open frame draws only the bar's empty box (at its final height): its controls mount once
  // that frame has painted, keeping worklist work off the finder-open path.
  const [painted, setPainted] = useState(false);
  const [drafts, setDrafts] = useState(false);
  // The panel takes focus as it opens, so its Escape (and Tab) start inside it, not in the field.
  useEffect(() => {
    if (drafts) host.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [drafts]);
  useEffect(() => {
    let live = true;
    afterPaint(() => live && setPainted(true));
    return () => {
      live = false;
    };
  }, []);
  const focus = () =>
    host.current?.parentElement?.parentElement
      ?.querySelector<HTMLInputElement>('input[role="combobox"]')
      ?.focus({ preventScroll: true });
  const cancel = () => {
    controller.setState({ choosing: null });
    focus();
  };
  const finish = () => {
    controller.setState(initial());
    focus();
  };
  if (drafts)
    return (
      <section
        ref={host}
        className={styles.picker}
        aria-label="Drafts worklists"
        onKeyDownCapture={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDrafts(false);
            focus();
          }
        }}
      >
        <FinderDrafts
          onCancel={() => {
            setDrafts(false);
            focus();
          }}
        />
      </section>
    );
  if (user && choosing)
    return (
      <section
        ref={host}
        className={styles.picker}
        aria-label="Add finder entries to worklist"
        onKeyDownCapture={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
      >
        <WorklistPicker items={choosing} close={finish} onCancel={cancel} />
      </section>
    );
  return (
    // The buttons swap as selection starts and ends: presses keep focus in the search field, so
    // the finder never loses focus to a button that just unmounted.
    <div
      ref={host}
      className={styles.bar}
      role="group"
      aria-label="Finder worklists"
      onMouseDown={(event) => event.preventDefault()}
    >
      {selecting ? (
        <>
          <button
            type="button"
            disabled={!count}
            onClick={() => controller.setState({ choosing: controller.getState().selected })}
          >
            Add {count} to worklist
          </button>
          <button
            type="button"
            disabled={!count}
            onClick={() => {
              controller.setState({ selected: [] });
              focus();
            }}
          >
            Clear
          </button>
          <button type="button" onClick={finish}>
            Done
          </button>
        </>
      ) : (
        painted && (
          <>
            {user && (
              <button
                type="button"
                title="Ctrl+Space selects the highlighted entry; Ctrl+Enter adds it to a worklist"
                onClick={() => {
                  controller.setState({ selecting: true });
                  focus();
                }}
              >
                Select entries
              </button>
            )}
            <button type="button" onClick={() => setDrafts(true)}>
              Drafts worklists
            </button>
          </>
        )
      )}
    </div>
  );
}
/** The per-category Drafts worklists, opened from the finder: each starts its own queue. */
function FinderDrafts({ onCancel }: { onCancel(): void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const closeSheet = useContext(FinderSheetCloseContext);
  const [status, setStatus] = useState('');
  function open({ id, items }: DraftGroup) {
    setStatus('');
    try {
      if (
        !usePreviewReviewStore
          .getState()
          .requestLeave(location.pathname, queueSources.drafts.path(items[0]!).split('?')[0]!)
      )
        return;
      const target = startQueue({
        source: 'drafts',
        scope: 'shown',
        items,
        first: items[0]!,
        origin: { path: `${location.pathname}${location.search}`, restore: { category: id } },
        focus: true,
      });
      closeSheet?.();
      navigate(target.to, { state: target.state });
    } catch {
      setStatus('Drafts could not be opened. Try again.');
    }
  }
  return (
    <DraftWorklistsPanel onOpen={open} onCancel={onCancel}>
      {status && (
        <span role="status" className={styles.hint}>
          {status}
        </span>
      )}
    </DraftWorklistsPanel>
  );
}
