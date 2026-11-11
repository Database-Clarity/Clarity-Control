import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Lang } from '@clarity/core';
import { languageLabel } from '../../languageLabels';
import { TooltipDiff } from '../history/TooltipDiff';
import { Overlay } from './StatusBar';
import { hasWorkingChanges, inView, type WorkingDiffSource } from './workingDiff';
import styles from './WorkingDiffPanel.module.scss';

/** How long typing must pause before the open view compares again. */
export const WORKING_DIFF_DELAY = 200;

/** Runs after the browser is idle (or shortly after, where idle callbacks do not exist). */
function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 500 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 0);
  return () => window.clearTimeout(id);
}

/**
 * "What did I change since the last save": the saved version against the text being edited, in
 * the History diff renderer, for the language in view only. Read-only. It mounts only while open,
 * so a closed view costs nothing; while open it compares again only after typing pauses, from an
 * idle callback, never inside a keystroke.
 */
export function WorkingDiffPanel({
  source,
  lang,
  onClose,
}: {
  source: WorkingDiffSource;
  lang: Lang;
  onClose(): void;
}) {
  const { saved, current } = source;
  const [shown, setShown] = useState(source);
  const stale = shown.saved !== saved || shown.current !== current;
  const latest = useRef(source);
  latest.current = source;
  useEffect(() => {
    if (!stale) return;
    let cancelIdle: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      cancelIdle = whenIdle(() => setShown(latest.current));
    }, WORKING_DIFF_DELAY);
    return () => {
      window.clearTimeout(timer);
      cancelIdle?.();
    };
    // Each new text restarts the wait: the comparison follows the last key, not every key.
  }, [stale, saved, current]);

  const body = useRef<HTMLDivElement>(null);
  // Opening on a long text shows its first change, not the unchanged top. Once per opening: the
  // view never scrolls by itself while you type. A large text is compared in a worker, so wait
  // for that result (aria-busy) before looking for the change.
  useLayoutEffect(() => {
    const element = body.current;
    const scroller = element?.closest<HTMLElement>('[data-overlay-scroll]');
    if (!element || !scroller) return;
    const reveal = () => {
      const mark = element.querySelector('ins, del') ?? element.querySelector('[data-source-change]');
      if (!mark) return;
      const top = mark.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      if (top > scroller.clientHeight * 0.6) scroller.scrollTop += top - scroller.clientHeight / 3;
    };
    if (!element.querySelector('[aria-busy="true"]')) return reveal();
    const observer = new MutationObserver(() => {
      if (element.querySelector('[aria-busy="true"]')) return;
      observer.disconnect();
      reveal();
    });
    observer.observe(element, { subtree: true, attributes: true, attributeFilter: ['aria-busy'] });
    return () => observer.disconnect();
  }, []);

  const diff = useMemo(
    () =>
      hasWorkingChanges(shown.saved, shown.current, lang) ? (
        <TooltipDiff
          before={inView(shown.saved, lang)}
          current={inView(shown.current, lang)}
          item={shown.item}
          raw={false}
        />
      ) : (
        <p className={styles.none}>No changes since the last save.</p>
      ),
    [shown, lang],
  );
  return (
    <Overlay
      id="editor-panel-diff"
      label="Changes since the last save"
      heading={
        <>
          Unsaved changes <span aria-hidden="true">·</span> {languageLabel(lang)}
        </>
      }
      onClose={onClose}
    >
      <div ref={body} className={styles.body} data-working-diff aria-busy={stale || undefined}>
        {diff}
      </div>
    </Overlay>
  );
}
