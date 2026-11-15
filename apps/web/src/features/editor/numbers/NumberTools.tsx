import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  memo,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from '@codemirror/view';
import { Overlay } from '../StatusBar';
import { placeChip } from '../markupRow/SuggestChip';
import { insertNumber, insertSourceNumber, dismissNumberOffer, type NumberStore } from './state';
import { convertTypedNumbers, typedNumberMatches, pointNumber } from './state';
import { tokenizedEnglish } from './model';
import rowStyles from '../markupRow/MarkupRow.module.scss';
import chipStyles from '../markupRow/SuggestChip.module.scss';
import styles from './NumberTools.module.scss';
import { missingNumberVariables } from './diagnostics';
import { dockedBarHeight } from '../markupRow/dock';
import { numberTokens } from '@clarity/core';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

function adjacentWord(context: string): string {
  const [before, after = ''] = context.split(' _ ');
  return (
    after.match(/\p{L}+/u)?.[0] ??
    before
      .replace(/#[\p{L}\p{N}]+/gu, '')
      .match(/\p{L}+/gu)
      ?.at(-1) ??
    ''
  );
}

export const NumberStatus = memo(function NumberStatus({
  store,
  className,
  open,
  onOpen,
  warning = false,
}: {
  store: NumberStore;
  className: string;
  open: boolean;
  onOpen(): void;
  warning?: boolean;
}) {
  const state = useStore(
    store,
    useShallow((state) => ({
      source: state.source,
      used: state.used,
      offer: !!state.offer,
      message: state.message,
    })),
  );
  if (!state.source) return null;
  const used = state.source.slots.filter((slot) => state.used.has(slot.id)).length;
  return (
    <button
      type="button"
      className={className}
      data-status-numbers
      data-severity={
        [...state.used].some((id) => !state.source!.values.has(id))
          ? 'error'
          : warning || state.offer || [...state.used].some((id) => state.source!.retired.has(id))
            ? 'warning'
            : undefined
      }
      title={state.message || 'Tab inserts the next number'}
      aria-expanded={open}
      aria-controls="editor-panel-numbers"
      aria-keyshortcuts="Control+K N"
      onClick={onOpen}
    >
      Numbers {used}/{state.source.slots.length}
      {state.message && (
        <span role="status" className={styles.message}>
          {state.message}
        </span>
      )}
    </button>
  );
});

export const NumberStrip = memo(function NumberStrip({
  store,
  view,
  onOpen,
  countOnly = false,
}: {
  store: NumberStore;
  view: RefObject<EditorView | null>;
  onOpen(): void;
  countOnly?: boolean;
}) {
  const state = useStore(
    store,
    useShallow((state) => ({
      source: state.source,
      used: state.used,
      offer: state.offer,
      next: state.next,
    })),
  );
  if (!state.source?.slots.length) return null;
  const slots = state.source.slots.filter((slot) => !state.used.has(slot.id));
  const next = slots.findIndex((slot) => slot.id === state.next);
  if (next > 0) slots.push(...slots.splice(0, next));
  if (countOnly)
    return (
      <button
        type="button"
        className={rowStyles.button}
        title="List all numbers"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onOpen}
      >
        {state.source.slots.length - slots.length}/{state.source.slots.length}
      </button>
    );
  return (
    <>
      {state.offer && (
        <button
          type="button"
          className={rowStyles.button}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (view.current) insertNumber(view.current, state.offer!.ids[0], state.offer!, true);
          }}
        >
          {state.offer.value} → token
        </button>
      )}
      {slots.map((slot) => (
        <button
          type="button"
          key={slot.id}
          className={rowStyles.button}
          data-number-chip={slot.id}
          title={`${slot.context} · ${slot.breadcrumb} · #${slot.id}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (view.current) insertSourceNumber(view.current, slot.id);
          }}
        >
          {slot.kind === 'S'
            ? `${slot.display.split('|')[0]}…`
            : slot.kind === 'M'
              ? `${slot.display} ƒ`
              : slot.display}
          {(state.source!.byDisplay.get(slot.display)?.length ?? 0) > 1 &&
            ` ${adjacentWord(slot.context)}`}
        </button>
      ))}
      <span className={rowStyles.separator} aria-hidden="true" />
    </>
  );
});

export function NumbersPanel({
  store,
  view,
  onClose,
  docked = false,
  readOnly = false,
}: {
  store: NumberStore;
  view: RefObject<EditorView | null>;
  onClose(): void;
  docked?: boolean;
  readOnly?: boolean;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const locked = readOnly || Boolean(view.current?.state.readOnly);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!docked) return;
    const panel = document.getElementById('editor-panel-numbers');
    const bar = document.querySelector('[data-markup-row][data-docked]');
    const place = () => panel?.style.setProperty('--number-bar-height', `${dockedBarHeight()}px`);
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (bar) observer?.observe(bar);
    return () => observer?.disconnect();
  }, [docked]);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const slots =
    state.source?.slots
      .filter((slot) =>
        `${slot.display} ${slot.context} ${slot.breadcrumb}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
      .sort((a, b) => Number(state.used.has(a.id)) - Number(state.used.has(b.id))) ?? [];
  const insert = (id: number) => {
    if (view.current && insertNumber(view.current, id)) onClose();
  };
  const pointed = slots[active]?.id;
  useLayoutEffect(() => {
    document
      .querySelector('#editor-panel-numbers li[data-active]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active, query]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    pointNumber(editor, pointed);
    return () => {
      pointNumber(editor);
    };
  }, [pointed, view]);
  const missing =
    view.current && state.source
      ? missingNumberVariables(
          view.current.state.doc.toString(),
          state.source.text,
          state.source.numbers,
          view.current.state.facet(numberHost).lang,
        )
      : [];
  const problems =
    view.current && state.source
      ? numberTokens(view.current.state.doc.toString()).filter(
          (token) => token.id === undefined || !state.source!.byId.has(token.id),
        )
      : [];
  const typed = view.current ? typedNumberMatches(view.current.state) : [];
  const close = () => {
    onClose();
    queueMicrotask(() => view.current?.focus());
  };
  return (
    <Overlay
      id="editor-panel-numbers"
      label="Numbers"
      heading="Numbers"
      onClose={close}
      keyboardAnchor={docked}
    >
      <div className={styles.panel}>
        {problems.map((token) => (
          <p key={token.from}>
            {token.id !== undefined && state.source?.retired.has(token.id)
              ? 'Removed from English'
              : 'Unknown number'}{' '}
            <button
              type="button"
              disabled={locked}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const editor = view.current;
                if (!editor || editor.state.readOnly) return;
                editor.dispatch({
                  changes: { from: token.from, to: token.to },
                  annotations: [isolateHistory.of('full'), Transaction.userEvent.of('delete')],
                });
              }}
            >
              Remove token
            </button>
          </p>
        ))}
        {state.offer && (
          <p>
            Typed number {state.offer.value}.{' '}
            <button
              type="button"
              disabled={locked}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (view.current && insertNumber(view.current, state.offer!.ids[0], state.offer!))
                  onClose();
              }}
            >
              Use number {state.offer.value} ({state.source?.byId.get(state.offer.ids[0])?.context})
            </button>
          </p>
        )}
        {missing.map((issue) => (
          <p key={`${issue.from}:${issue.name}`}>
            Formula needs {issue.name}.{' '}
            <button
              type="button"
              disabled={locked}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (view.current && insertNumber(view.current, issue.id, issue)) onClose();
              }}
            >
              Add variable {issue.name}
            </button>
          </p>
        ))}
        <input
          ref={input}
          value={query}
          aria-label="Filter numbers"
          placeholder="Filter numbers"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) =>
                Math.max(
                  0,
                  Math.min(slots.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                ),
              );
            } else if (event.key === 'Enter' && slots[active]) {
              event.preventDefault();
              insert(slots[active].id);
            }
          }}
        />
        {!slots.length && <p>No numbers match.</p>}
        <ul aria-label="Numbers, to do first">
          {slots.map((slot, index) => (
            <li
              key={slot.id}
              data-active={active === index || undefined}
              onMouseMove={() => setActive(index)}
            >
              <span>
                <strong>{slot.display}</strong> · {slot.context}
                <small>
                  {slot.breadcrumb} · #{slot.id}
                </small>
              </span>
              <span>{state.used.has(slot.id) ? 'Used' : 'To do'}</span>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  view.current?.dom.dispatchEvent(
                    new CustomEvent('clarity-number-reveal', {
                      bubbles: true,
                      detail: { id: slot.id, hash: Number(view.current.dom.dataset.tooltipHash) },
                    }),
                  );
                  onClose();
                }}
              >
                Reveal
              </button>
              <button
                type="button"
                disabled={locked}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(slot.id)}
              >
                Insert
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          disabled={locked || !typed.some((match) => match.ids.length === 1)}
          onClick={() => {
            if (view.current && convertTypedNumbers(view.current)) onClose();
          }}
        >
          Convert typed numbers
        </button>
        {typed.some((match) => match.ids.length > 1) && (
          <p>
            Choose a number for:{' '}
            {typed
              .filter((match) => match.ids.length > 1)
              .map((match) => match.value)
              .join(', ')}
            .
          </p>
        )}
      </div>
    </Overlay>
  );
}

export function startFromEnglish(view: EditorView): boolean {
  const source = view.state.facet(numberHost).source;
  if (!source || source.issue || view.state.readOnly || view.state.doc.length) return false;
  view.dispatch({
    changes: { from: 0, insert: tokenizedEnglish(source) },
    selection: { anchor: 0 },
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.paste')],
  });
  view.focus();
  requestAnimationFrame(() => requestAnimationFrame(() => view.focus()));
  return true;
}
import { numberHost } from './state';
import { isolateHistory } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';

/** Display-only while cycling; typed-number offers alone claim Tab or have buttons. */
export function NumberReadout({
  store,
  view,
}: {
  store: NumberStore;
  view: RefObject<EditorView | null>;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const slot = state.source?.byId.get(state.cycle ?? state.offer?.ids[0] ?? -1);
  const duplicate = slot && (state.source!.byDisplay.get(slot.display)?.length ?? 0) > 1;
  const shown = Boolean(slot && (state.offer || duplicate));
  const surface = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!shown || !editor) {
      setPosition(null);
      return;
    }
    const place = () => {
      const to = state.offer?.to ?? editor.state.selection.main.head;
      const from = state.offer?.from ?? Math.max(0, to - `#{=${slot!.id}}`.length);
      setPosition(
        placeChip(
          editor,
          { covers: { from, to } },
          {
            width: surface.current?.offsetWidth ?? 280,
            height: surface.current?.offsetHeight ?? 26,
          },
        ),
      );
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [shown, slot, state.offer, view]);
  if (!shown || !slot) return null;
  const label = `${slot.display} · ${slot.context} · ${slot.breadcrumb} · ${state.source!.slots.indexOf(slot) + 1} of ${state.source!.slots.length} · #${slot.id}`;
  return createPortal(
    <div
      ref={surface}
      className={`${chipStyles.chip} ${!state.offer ? styles.readout : ''}`}
      role="status"
      data-number-readout
      style={position ? { ...position, position: 'fixed' } : { visibility: 'hidden' }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {state.offer ? (
        <>
          <button
            type="button"
            className={chipStyles.accept}
            onClick={() => {
              if (view.current) insertNumber(view.current, slot.id, state.offer!, true);
            }}
          >
            <code className={chipStyles.markup}>{state.offer.value} → number</code>
            <span className={chipStyles.text}>{slot.context}</span>
            <kbd>Tab</kbd>
          </button>
          <button
            type="button"
            className={chipStyles.dismiss}
            aria-label="Dismiss suggestion"
            onClick={() => {
              if (view.current) dismissNumberOffer(view.current);
            }}
          >
            <span className={chipStyles.esc}>Esc</span>
            <span className={chipStyles.cross}>×</span>
          </button>
        </>
      ) : (
        <span>{label}</span>
      )}
    </div>,
    document.body,
  );
}
