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
import type { EditorData } from '../../stores/data';
import type { WorklistEntry } from '../../../../../packages/core/src/worklists';
import { FinderSheetCloseContext } from '../navigation/FinderSheetContext';
import { WorklistPicker } from './WorklistsMenu';
import { draftItems } from './savedSources';
import { startQueue } from './start';
import styles from './FinderWorklists.module.scss';

interface Selection {
  selecting: boolean;
  selected: WorklistEntry[];
  choosing: WorklistEntry[] | null;
}
export type FinderWorklistController = StoreApi<Selection>;
const initial = (): Selection => ({ selecting: false, selected: [], choosing: null });
const Context = createContext<FinderWorklistController | null>(null);
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
  data,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  controller: FinderWorklistController;
  data: EditorData;
  children: ReactNode;
}) {
  return (
    <Context.Provider value={controller}>
      <div {...props}>
        <FinderWorklistBar data={data} />
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
  const controller = useContext(Context)!;
  const choosing = useStore(controller, (state) => state.choosing !== null);
  const user = useAuthStore((state) => Boolean(state.user));
  const selecting = useStore(controller, (state) => state.selecting);
  const selected = useStore(controller, (state) =>
    state.selected.some((item) => item.hash === hash),
  );
  if (global || !user) return children;
  return (
    <span
      className={styles.row}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
      <button
        type="button"
        className={styles.action}
        disabled={choosing}
        role={selecting ? 'checkbox' : undefined}
        aria-checked={selecting ? selected : undefined}
        aria-label={selecting ? `Select ${name} for worklist` : `Add ${name} to worklist`}
        title={selecting ? 'Select for worklist (Ctrl+Space)' : 'Add to worklist (Ctrl+Enter)'}
        onClick={() =>
          selecting
            ? toggle(controller, { hash, name })
            : controller.setState({ choosing: [{ hash, name }] })
        }
      >
        {selecting ? (selected ? '✓' : '□') : '+'}
      </button>
    </span>
  );
}
function FinderWorklistBar({ data }: { data: EditorData }) {
  const controller = useContext(Context)!;
  const user = useAuthStore((state) => Boolean(state.user));
  const selecting = useStore(controller, (state) => state.selecting);
  const count = useStore(controller, (state) => state.selected.length);
  const choosing = useStore(controller, (state) => state.choosing);
  const host = useRef<HTMLDivElement>(null);
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
  return (
    <div
      ref={host}
      className={styles.bar}
      onKeyDownCapture={(event) => {
        if (choosing && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      {!choosing && (
        <div className={styles.tools} role="group" aria-label="Finder worklists">
          <FinderDraftsButton data={data} />
          {user && (
            <button
              type="button"
              aria-pressed={selecting}
              onClick={() => controller.setState(selecting ? initial() : { selecting: true })}
            >
              Select entries
            </button>
          )}
          {user && selecting && (
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
                onClick={() => controller.setState({ selected: [] })}
              >
                Clear selection
              </button>
            </>
          )}
        </div>
      )}
      {user && !choosing && selecting && (
        <span className={styles.hint}>Ctrl+Space selects; Ctrl+Enter adds to a worklist.</span>
      )}
      {user && choosing && (
        <section className={styles.picker} aria-label="Add finder entries to worklist">
          <WorklistPicker items={choosing} close={finish} />
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </section>
      )}
    </div>
  );
}
function FinderDraftsButton({ data }: { data: EditorData }) {
  const navigate = useNavigate();
  const location = useLocation();
  const closeSheet = useContext(FinderSheetCloseContext);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [location.key],
  );
  async function openDrafts() {
    const attempt = ++request.current;
    setBusy(true);
    setStatus('');
    try {
      const items = await draftItems(data);
      if (attempt !== request.current) return;
      if (!items.length) {
        setStatus('No bulk drafts need English text.');
        return;
      }
      const target = startQueue({
        source: 'drafts',
        scope: 'shown',
        items,
        first: items[0]!,
        origin: { path: `${location.pathname}${location.search}`, restore: {} },
        focus: true,
      });
      closeSheet?.();
      navigate(target.to, { state: target.state });
    } catch {
      if (attempt === request.current) setStatus('Drafts could not be opened. Try again.');
    } finally {
      if (attempt === request.current) setBusy(false);
    }
  }
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void openDrafts()}>
        Drafts worklist
      </button>
      {status && (
        <span role="status" className={styles.hint}>
          {status}
        </span>
      )}
    </>
  );
}
