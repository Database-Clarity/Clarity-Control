import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from '@codemirror/view';
import { parseMarkup, type Lang, type MarkupGlobals } from '@clarity/core';
import { MarkupSnippet } from '../../preview/TooltipPreview';
import { acceptSuggestion, moveSuggest, type SuggestSnapshot } from './state';
import type { SuggestContext } from './source';
import type { UsageCorpus } from './usage';
import styles from './SuggestMenu.module.scss';

/** Keeps the preview from ever breaking the menu: markup the parser rejects shows no preview. */
function parses(text: string, globals: MarkupGlobals): boolean {
  try {
    parseMarkup(text, globals);
    return true;
  } catch {
    return false;
  }
}

interface Placement {
  left: number;
  top: number;
  maxHeight: number;
  /** The menu sits over the caret line's top edge instead of under it. */
  above: boolean;
}

const edge = 8;
const gap = 4;

function place(view: EditorView, context: SuggestContext, width: number): Placement | null {
  const anchor = view.coordsAtPos(context.kind === 'selection' ? context.to : context.from);
  // The visible area, which the on-screen keyboard shortens (the layout viewport does not).
  const viewport = window.visualViewport;
  const bottomEdge = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  if (!anchor) return null;
  const below = bottomEdge - anchor.bottom - gap - edge;
  const above = anchor.top - gap - edge;
  const useBelow = below >= 240 || below >= above;
  const space = Math.max(120, Math.min(useBelow ? below : above, 340));
  return {
    left: Math.min(Math.max(edge, anchor.left), Math.max(edge, window.innerWidth - width - edge)),
    // Above the line the menu hangs from this edge (translateY(-100%) in the stylesheet).
    top: useBelow ? anchor.bottom + gap : anchor.top - gap,
    maxHeight: space,
    above: !useBelow,
  };
}

export function SuggestMenu({
  snapshot,
  view,
  globals,
  lang,
  usage,
}: {
  snapshot: SuggestSnapshot;
  view: EditorView;
  globals: MarkupGlobals;
  lang: Lang;
  usage?: UsageCorpus;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const selected = snapshot.items[snapshot.index];
  const { context } = snapshot;
  const itemCount = snapshot.items.length;

  useLayoutEffect(() => {
    const measure = () => {
      const width = surface.current?.offsetWidth ?? 544;
      setPlacement(place(view, context, width));
    };
    measure();
    const scroller = view.scrollDOM;
    scroller.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      scroller.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [view, context, itemCount]);

  useEffect(() => {
    surface.current
      ?.querySelector<HTMLElement>(`#editor-suggest-option-${snapshot.index}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [snapshot.index, snapshot.items]);

  const previewText = useMemo(() => {
    if (!selected?.preview) return null;
    const text = snapshot.context.definitions
      ? `${snapshot.context.definitions}\n${selected.preview}`
      : selected.preview;
    return parses(text, globals) ? text : null;
  }, [selected, snapshot.context.definitions, globals]);
  const used = useMemo(
    () => (selected?.usage && usage ? usage.count(selected.usage) : undefined),
    [selected, usage],
  );

  if (!placement || !selected) return null;
  const style = {
    '--menu-left': `${placement.left}px`,
    '--menu-top': `${placement.top}px`,
    '--menu-max': `${placement.maxHeight}px`,
  } as CSSProperties;
  let lastCategory = '';
  return createPortal(
    <div
      ref={surface}
      className={`${styles.menu} ${placement.above ? styles.above : ''}`}
      style={style}
      data-suggest-menu
      // Pressing inside never takes focus from the editor, so the caret and selection stay put.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div
        className={styles.list}
        role="listbox"
        id="editor-suggest-list"
        aria-label="Markup suggestions"
      >
        {snapshot.items.map((item, index) => {
          const header = item.category !== lastCategory;
          lastCategory = item.category;
          return (
            <Fragment key={item.id}>
              {header && (
                <div className={styles.category} role="presentation">
                  {item.category}
                </div>
              )}
              <div
                id={`editor-suggest-option-${index}`}
                role="option"
                aria-selected={index === snapshot.index}
                className={styles.option}
                data-category={item.category}
                onMouseMove={() => index !== snapshot.index && moveSuggest(view, index, true)}
                onClick={() => acceptSuggestion(view, index)}
              >
                <span className={styles.label}>{item.label}</span>
                {item.hint && <span className={styles.hint}>{item.hint}</span>}
              </div>
            </Fragment>
          );
        })}
      </div>
      <div className={styles.detail} data-suggest-detail>
        <div className={styles.head}>
          <span className={styles.title}>{selected.label}</span>
          <span className={styles.kind}>{selected.category}</span>
        </div>
        <pre className={styles.markup} lang={undefined}>
          {selected.insert}
        </pre>
        {previewText && (
          <div className={styles.rendered} aria-label="Preview">
            <MarkupSnippet text={previewText} lang={lang} globals={globals} />
          </div>
        )}
        <p className={styles.about}>{selected.about}</p>
        {used !== undefined && (
          <p className={styles.usage} data-suggest-usage>
            {used === 0
              ? 'Not used in any tooltip yet'
              : `Used in ${new Intl.NumberFormat().format(used)} ${used === 1 ? 'tooltip' : 'tooltips'}`}
          </p>
        )}
        {snapshot.message && (
          <p className={styles.note} role="alert">
            {snapshot.message}
          </p>
        )}
        <p className={styles.keys}>↑↓ choose · Enter or Tab inserts · Esc closes</p>
      </div>
    </div>,
    document.body,
  );
}
