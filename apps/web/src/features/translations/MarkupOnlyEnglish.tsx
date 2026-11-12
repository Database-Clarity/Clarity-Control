import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { elementTagNames, findElementTags, type ElementTag } from '@clarity/core';
import { ReadingTooltip } from '../preview/ReadingTooltip';
import { elementLabel } from '../editor/elementTags';
import { linePairs, type IconPair } from '../editor/iconPairs';
import { openSuggest } from '../editor/suggest/state';
import { useShowEditor } from '../tooltip/VariantWorkspace';
import previewStyles from '../preview/TooltipPreview.module.scss';
import styles from './MarkupOnlyEnglish.module.scss';

/** A tagged span and where it sits in the lowered text (the same in both versions of the English). */
interface PlacedTag extends ElementTag {
  key: string;
  /** Which tinted span of this element and text it is, in reading order. */
  occurrence: number;
}

/** `<solar Scorch />` is 2 characters longer than its lowered `<solar/>Scorch`. */
function placedTags(text: string): PlacedTag[] {
  const seen = new Map<string, number>();
  return findElementTags(text).map((tag, index) => {
    const words = `${tag.element}:${tag.text.trim()}`;
    const occurrence = seen.get(words) ?? 0;
    seen.set(words, occurrence + 1);
    return { ...tag, key: `${tag.from - 2 * index}:${tag.element}:${tag.text}`, occurrence };
  });
}

/** The spans tagged (or given another element) in `current` that `before` did not have. */
export function newlyTagged(before: string, current: string): PlacedTag[] {
  const old = new Set(placedTags(before).map((tag) => tag.key));
  return placedTags(current).filter((tag) => !old.has(tag.key));
}

/** The translation's untagged pairs of the given elements, in text order. */
export function translationPairs(view: EditorView, elements: ReadonlySet<string>): IconPair[] {
  const pairs: IconPair[] = [];
  const { doc } = view.state;
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    if (!line.text.includes('/>')) continue;
    for (const pair of linePairs(view.state, line.from))
      if (elements.has(pair.element)) pairs.push(pair);
  }
  return pairs;
}

const translationEditor = (hash: number) => {
  const root = document.querySelector<HTMLElement>(`.cm-editor[data-tooltip-hash="${hash}"]`);
  return root ? EditorView.findFromDOM(root) : null;
};

/**
 * A markup-only English change, rendered like the current English with the newly tagged spans
 * outlined (dotted; no layout change), and "Tag the same words here": each press moves to the next
 * matching pair in the translation (the same element's icon before a word), selects it, and opens
 * Ctrl+Space on that element's wrap. The translator decides each one.
 */
export function MarkupOnlyEnglish({
  before,
  current,
  hash,
}: {
  before: string;
  current: string;
  hash: number;
}) {
  const added = useMemo(() => newlyTagged(before, current), [before, current]);
  const host = useRef<HTMLDivElement>(null);
  const showEditor = useShowEditor();
  const [note, setNote] = useState('');

  // The rendered spans carry no source positions: the outlined ones are found by element and
  // text in reading order, and found again whenever the rendering is replaced.
  useEffect(() => {
    const element = host.current;
    if (!element || !added.length) return;
    const mark = () => {
      const spans = element.querySelectorAll<HTMLElement>(`.${previewStyles.elementText}`);
      const counts = new Map<string, number>();
      for (const span of spans) {
        const name = elementTagNames.find((element) =>
          span.classList.contains(previewStyles[element] ?? '\0'),
        );
        const words = `${name}:${span.textContent?.trim() ?? ''}`;
        const occurrence = counts.get(words) ?? 0;
        counts.set(words, occurrence + 1);
        const isNew = added.some(
          (tag) => `${tag.element}:${tag.text.trim()}` === words && tag.occurrence === occurrence,
        );
        // Attributes only: the observer below watches the rendering, not these marks.
        if (isNew !== span.hasAttribute('data-new-tag'))
          span.toggleAttribute('data-new-tag', isNew);
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [added]);

  const elements = useMemo(() => new Set(added.map((tag) => tag.element)), [added]);

  function step() {
    const view = translationEditor(hash);
    if (!view || view.state.readOnly) {
      setNote('Open the translation in the editor to tag it.');
      return;
    }
    const pairs = translationPairs(view, elements);
    if (!pairs.length) {
      setNote(
        `No untagged ${[...elements].map(elementLabel).join(' or ')} icon before a word in the translation.`,
      );
      return;
    }
    // The next pair after the caret (around to the first); the translator decides each one.
    const head = view.state.selection.main.to;
    const index = Math.max(
      0,
      pairs.findIndex((pair) => pair.iconFrom >= head),
    );
    const pair = pairs[index]!;
    setNote(`${index + 1} of ${pairs.length}: “${pair.text}”`);
    showEditor();
    // A hidden panel (the phone's Editor tab) lays out first, then takes the caret.
    requestAnimationFrame(() => {
      if (pair.spaced) {
        // Grouping drops the space: the icon's popover offers it and asks.
        view.dispatch({
          selection: { anchor: pair.iconFrom, head: pair.iconTo },
          scrollIntoView: true,
        });
        view.focus();
        return;
      }
      view.dispatch({
        selection: { anchor: pair.from, head: pair.to },
        scrollIntoView: true,
      });
      view.focus();
      openSuggest(view, `icon:${pair.element}`);
    });
  }

  return (
    <>
      <p data-markup-only className={styles.notice}>
        <strong>Markup only:</strong> the English words did not change; only element tags (an icon
        grouped with its words) were added, changed, or removed. The translation needs no change for
        it.
      </p>
      <div ref={host} className={styles.rendered} data-markup-only-text>
        <ReadingTooltip text={current} hash={hash} />
      </div>
      {added.length > 0 && (
        <p className={styles.tagHere}>
          <button
            type="button"
            className={styles.link}
            data-tag-here
            title={`Selects the next ${[...elements].map(elementLabel).join(' or ')} icon and its word in the translation, and offers to tag them`}
            onClick={step}
          >
            Tag the same words here
          </button>
          {note && (
            <span className={styles.note} role="status">
              {note}
            </span>
          )}
        </p>
      )}
    </>
  );
}
