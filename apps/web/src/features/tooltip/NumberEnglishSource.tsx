import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Lang } from '@clarity/core';
import { ReadingSlots } from '../preview/ReadingTooltip';
import { TermLayer, type Mark, type SpanSource } from '../terms/TermLayer';
import { translationView } from '../terms/insert';
import { useNumberDocument } from '../editor/numbers/documents';
import { insertSourceNumber } from '../editor/numbers/state';
import type { NumberSource } from '../editor/numbers/model';
import styles from './NumberEnglishSource.module.scss';
import { useStore } from 'zustand';
import { createPortal } from 'react-dom';

/** Raw after-side pieces keep their exact source offsets, including split WordDiff runs. */
export function numberAfter(source: NumberSource, text: string, offset: number): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const slot of source.slots) {
    const from = Math.max(0, slot.from - offset),
      to = Math.min(text.length, slot.to - offset);
    if (to <= from) continue;
    if (from > at) parts.push(text.slice(at, from));
    parts.push(
      <span key={`${slot.id}:${from}`} data-slot={slot.id}>
        {text.slice(from, to)}
      </span>,
    );
    at = to;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

export function NumberEnglishSource({
  hash,
  lang,
  enabled,
  canInsert,
  stepping,
  text,
  raw = false,
  changes = false,
  children,
}: {
  hash: number;
  lang: Lang;
  enabled: boolean;
  canInsert: boolean;
  stepping: boolean;
  text: string;
  raw?: boolean;
  changes?: boolean;
  children(renderAfter?: (text: string, offset: number) => ReactNode): ReactNode;
}) {
  const store = useNumberDocument(hash, lang);
  const currentSource = useStore(store, (state) => state.source);
  const source = currentSource?.text === text ? currentSource : null;
  const root = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<readonly number[]>([]);
  const [pane, setPane] = useState<HTMLElement | null>(null);
  const slotContext = useMemo(
    () => (source ? { text, ids: source.slots.map((slot) => slot.id), hash } : undefined),
    [source, text, hash],
  );
  useLayoutEffect(() => {
    let frame = 0;
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<{ hash: number; id: number }>).detail;
      if (detail?.hash !== hash || !source?.byId.has(detail.id)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const span = root.current?.querySelector<HTMLElement>(`[data-slot="${detail.id}"]`);
          if (!span) return;
          span.scrollIntoView({ block: 'center', inline: 'nearest' });
          span.tabIndex = -1;
          span.focus({ preventScroll: true });
        });
      });
    };
    window.addEventListener('clarity-number-reveal', reveal);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('clarity-number-reveal', reveal);
    };
  }, [hash, source]);
  const renderAfter = useCallback(
    (text: string, offset: number) => (source ? numberAfter(source, text, offset) : text),
    [source],
  );
  const spanSource: SpanSource = useCallback(
    (element) => {
      if (!source) return [];
      return [...element.querySelectorAll<HTMLElement>('[data-slot]')]
        .filter((span) => !span.closest('[role=tooltip]'))
        .flatMap((span): Mark[] => {
          const slot = source.byId.get(Number(span.dataset.slot));
          if (!slot) return [];
          const range = document.createRange();
          range.selectNodeContents(span);
          return [
            {
              range,
              term: {
                en: slot.display,
                kind: 'number',
                official: [slot.display],
                insertOnClick: true,
                number: {
                  kind: { N: 'Number', S: 'Stacked', M: 'Formula' }[slot.kind],
                  context: slot.context,
                  scope: `${slot.breadcrumb} · #${slot.id}`,
                  insert: () => {
                    const view = translationView(hash);
                    return !!view && insertSourceNumber(view, slot.id);
                  },
                },
              },
            },
          ];
        });
    },
    [source, hash],
  );
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !source || stepping || raw) {
      setHidden([]);
      return;
    }
    const find = () => {
      setPane(element.querySelector<HTMLElement>('[data-number-source]'));
      if (changes && !element.querySelector('[data-number-source]')) {
        setHidden([]);
        return;
      }
      const visible = new Set(
        [...element.querySelectorAll<HTMLElement>('[data-slot]:not([data-hidden-number])')]
          .filter((span) => !span.closest('[role=tooltip]'))
          .map((span) => Number(span.dataset.slot)),
      );
      const next = source.slots.filter((slot) => !visible.has(slot.id)).map((slot) => slot.id);
      setHidden((previous) => (previous.join(',') === next.join(',') ? previous : next));
    };
    find();
    const observer = new MutationObserver(find);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [source, stepping, raw, changes]);

  // Root-approved §4.5 exception: style existing spans to avoid global Highlight repainting.
  // Element identities stay installed while typing; only changed states write an attribute.
  const marked = useRef(new Map<HTMLElement, string>());
  useLayoutEffect(() => {
    if (!root.current || stepping || !source) return;
    let pointed: number | undefined;
    let spans: { element: HTMLElement; id: number }[] = [];
    const clear = () => {
      for (const { element } of spans) {
        if (element.dataset.numberState === marked.current.get(element))
          delete element.dataset.numberState;
        marked.current.delete(element);
      }
    };
    const apply = () => {
      const snapshot = store.getSnapshot();
      for (const { element, id } of spans) {
        const name =
          id === (pointed ?? snapshot.next) ? 'next' : snapshot.used.has(id) ? 'used' : 'todo';
        const previous = marked.current.get(element);
        if (name === previous) continue;
        element.dataset.numberState = name;
        marked.current.set(element, name);
      }
    };
    const rebuild = () => {
      clear();
      spans = [...root.current!.querySelectorAll<HTMLElement>('[data-slot]')]
        .filter(
          (element) =>
            !element.closest('[role="tooltip"]') && source.byId.has(Number(element.dataset.slot)),
        )
        .map((element) => ({ element, id: Number(element.dataset.slot) }));
      apply();
    };
    rebuild();
    const point = (event: Event) => {
      const detail = (event as CustomEvent<{ hash: number; id?: number }>).detail;
      if (detail?.hash !== hash) return;
      pointed = detail.id;
      apply();
      if (pointed !== undefined)
        root.current
          ?.querySelector<HTMLElement>(`[data-slot="${pointed}"]`)
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    window.addEventListener('clarity-number-point', point);
    const observer = new MutationObserver(rebuild);
    observer.observe(root.current, { childList: true, subtree: true });
    const unsubscribe = store.subscribe(apply);
    return () => {
      unsubscribe();
      window.removeEventListener('clarity-number-point', point);
      observer.disconnect();
      clear();
    };
  }, [source, stepping, spanSource, store, hidden, raw, hash]);
  return (
    <ReadingSlots.Provider value={slotContext}>
      <div ref={root} className={styles.source}>
        <TermLayer
          hash={hash}
          lang={lang}
          enabled={enabled && !changes && !raw}
          canInsert={canInsert}
          stepping={stepping}
          spanSource={source ? spanSource : undefined}
        >
          {children(source ? renderAfter : undefined)}
          {!raw &&
            pane &&
            hidden.length > 0 &&
            createPortal(
              <p className={styles.hidden}>
                Not shown in the text:{' '}
                {hidden.map((id, index) => (
                  <span key={id}>
                    {index > 0 && ', '}
                    {source?.byId.get(id)?.variable && `${source.byId.get(id)!.variable} = `}
                    <span data-slot={id} data-hidden-number>
                      {source?.byId.get(id)?.kind === 'M'
                        ? source.byId.get(id)?.display
                        : source?.byId.get(id)?.value}
                    </span>
                  </span>
                ))}
              </p>,
              pane,
            )}
        </TermLayer>
      </div>
    </ReadingSlots.Provider>
  );
}
