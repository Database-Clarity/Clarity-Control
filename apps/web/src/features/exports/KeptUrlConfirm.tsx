import type { RetainedConfirmationResponse } from '@clarity/export/config';
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  applyPlacement,
  followPlacement,
  naturalHeight,
  placeAnchored,
  visibleArea,
} from '../../ui/anchorPlacement';
import { useWorkspaceShortcutOwner } from '../../ui/interaction';
import popover from '../../ui/Popover.module.scss';
import styles from './Exports.module.scss';

/** A save refusal leaves the draft untouched until its exact deletion list is accepted. */
export function KeptUrlConfirm({
  anchor,
  details,
  onCancel,
  onConfirm,
}: {
  anchor: RefObject<HTMLButtonElement>;
  details: RetainedConfirmationResponse['details'];
  onCancel(): void;
  onConfirm(): void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useWorkspaceShortcutOwner(surface, true);
  useLayoutEffect(() => {
    const place = () => {
      if (!surface.current || !anchor.current) return;
      const input = {
        trigger: anchor.current.getBoundingClientRect(),
        area: visibleArea(window),
        width: 440,
      };
      applyPlacement(surface.current, placeAnchored(input));
      applyPlacement(
        surface.current,
        placeAnchored({
          ...input,
          height: naturalHeight(surface.current, surface.current.firstElementChild as HTMLElement),
        }),
      );
    };
    place();
    return followPlacement(() => surface.current, place);
  }, [anchor]);
  useEffect(() => {
    cancel.current?.focus();
    const trigger = anchor.current;
    return () => trigger?.focus();
  }, [anchor]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        !surface.current?.contains(event.target as Node) &&
        !anchor.current?.contains(event.target as Node)
      )
        onCancel();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
      if (event.key === 'Tab') {
        const buttons = surface.current?.querySelectorAll('button');
        if (!buttons?.length) return;
        const first = buttons[0]!;
        const last = buttons[buttons.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [anchor, onCancel]);
  return createPortal(
    <div
      ref={surface}
      role="dialog"
      aria-label="Delete kept URLs and save?"
      className={popover.surface}
    >
      <div className={popover.body}>
        <p>Saving will delete the oldest kept URLs:</p>
        <ul className={styles.urlList}>
          {details.deletions.flatMap((entry, i) =>
            entry.urls.map((url, j) => <li key={`${i}:${j}`}>{url}</li>),
          )}
        </ul>
        <p>Delete them and save?</p>
        <div className={styles.confirmActions}>
          <button ref={cancel} type="button" className={styles.button} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={styles.danger} onClick={onConfirm}>
            Delete and save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
