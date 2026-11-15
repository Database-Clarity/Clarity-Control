import { useContext, useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { numberSlots } from '@clarity/core';
import { ReadingSlots } from '../preview/ReadingTooltip';
import { clarityHighlighting, clarityLanguage } from '../editor/language';
import styles from './EnglishRaw.module.scss';

/**
 * The English as its markup source (translate mode's Raw): read-only, highlighted like the editor
 * (the same language and highlight style), selectable and copyable. No term marks here: the
 * rendered views and the Terms list (Ctrl+K, then G) carry them.
 */
export function EnglishRaw({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const slots = useContext(ReadingSlots);
  const marks = useRef(new Compartment());
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          // Focusable though not editable, so Ctrl+A selects just the markup, ready to copy.
          EditorView.contentAttributes.of({
            'aria-label': 'English markup',
            'aria-readonly': 'true',
            role: 'textbox',
            tabindex: '0',
            lang: 'en',
          }),
          EditorView.domEventHandlers({
            keydown(event, view) {
              if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a')
                return false;
              event.preventDefault();
              window.getSelection()?.selectAllChildren(view.contentDOM);
              return true;
            },
          }),
          clarityLanguage,
          clarityHighlighting,
          marks.current.of(EditorView.decorations.of(Decoration.none)),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The text is swapped in place below; the view lives as long as the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const decorations =
      slots?.text === text
        ? Decoration.set(
            numberSlots(text).flatMap((slot, index) =>
              slots.ids[index] === undefined
                ? []
                : [
                    Decoration.mark({
                      attributes: { 'data-slot': String(slots.ids[index]) },
                    }).range(slot.from, slot.to),
                  ],
            ),
          )
        : Decoration.none;
    editor.dispatch({
      ...(editor.state.doc.toString() === text
        ? {}
        : { changes: { from: 0, to: editor.state.doc.length, insert: text } }),
      effects: marks.current.reconfigure(EditorView.decorations.of(decorations)),
    });
  }, [text, slots]);
  return <div ref={host} className={styles.raw} data-english-raw="" />;
}
