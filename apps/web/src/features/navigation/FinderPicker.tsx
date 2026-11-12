import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  applyPlacement,
  followPlacement,
  placeAnchored,
  visibleArea,
} from '../../ui/anchorPlacement';
import { scaledPx } from '../../ui/scale';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import { FinderIcon } from './FinderIcon';
import styles from './FinderPicker.module.scss';

export interface PickerOption {
  id: string;
  label: string;
  /** Icon path or URL; rows of a picker with icons keep the box even without one. */
  icon?: string;
}
export interface PickerSection {
  /** A heading over the options (like an optgroup); none for a flat list. */
  label?: string;
  options: PickerOption[];
}

/** Popover parts portalled out of a shell overlay mark themselves, so it does not take a press there as outside. */
export const overlayPartAttribute = 'data-overlay-part';

/**
 * The finder's custom dropdowns (category, weapon, activity, artifact): a select-only combobox.
 * Focus stays on the trigger, which owns the keyboard through `aria-activedescendant`: Down, Up,
 * Enter, Space, or Alt+Down open it; arrows, Page Up/Down, and Home/End move; typing jumps to the
 * next label that starts with the typed text; Enter or Space chooses; Escape or Tab closes. There
 * is no text field, so an iPhone never zooms. The list hangs from the trigger like every popover
 * (below it, or above when that has more room) and reports only a change of value.
 */
export const FinderPicker = memo(function FinderPicker({
  label,
  sections,
  value,
  onChange,
  className,
  disabled = false,
  icons = false,
  empty,
}: {
  label: string;
  sections: PickerSection[];
  value: string;
  onChange(id: string): void;
  className?: string;
  disabled?: boolean;
  /** Rows (and the trigger) carry an icon box. */
  icons?: boolean;
  /** The trigger's text when nothing is listed. */
  empty?: string;
}) {
  const base = useId();
  const phone = useMedia(phoneQuery);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const options = sections.flatMap((section) => section.options);
  const selectedIndex = options.findIndex((option) => option.id === value);
  const selected = options[selectedIndex];
  const [active, setActive] = useState(0);
  const typed = useRef({ text: '', at: 0 });
  const optionId = (index: number) => `${base}-o${index}`;

  const show = (index = selectedIndex) => {
    if (disabled || !options.length) return;
    setActive(Math.max(0, Math.min(options.length - 1, index)));
    setOpen(true);
  };
  const close = useCallback(() => setOpen(false), []);
  const choose = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option && option.id !== value) onChange(option.id);
  };

  // Placement: by the trigger, at least as wide as it, inside the visible area.
  const place = useCallback(() => {
    const element = popup.current;
    const anchor = trigger.current;
    if (!element || !anchor) return;
    const own = anchor.getBoundingClientRect();
    // On a phone the list spans the trigger's control row (the finder's inner width), from the
    // row's left edge: a narrow trigger beside the stepper still gets a readable list. On a
    // desktop it starts at the trigger and is at least 15rem wide.
    const row = phone ? anchor.parentElement?.getBoundingClientRect() : undefined;
    const rect = row ? { top: own.top, bottom: own.bottom, left: row.left, right: row.right } : own;
    const area = visibleArea(window);
    const input = {
      trigger: rect,
      area,
      width: row ? row.width : Math.max(own.width, scaledPx(15 * 16)),
      align: 'start' as const,
      gap: 2,
    };
    // At most about 14 rows: a long list (every exotic weapon) scrolls inside.
    const cap = scaledPx(400);
    const natural = Math.min(cap, (list.current?.scrollHeight ?? 0) + 2);
    const below = placeAnchored(input);
    const placed = natural > below.maxHeight ? placeAnchored({ ...input, height: natural }) : below;
    applyPlacement(element, { ...placed, maxHeight: Math.min(placed.maxHeight, cap) });
  }, [phone]);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    return followPlacement(() => popup.current, place);
  }, [open, place]);

  // The chosen option starts in view; a moved highlight stays in view (no smooth scroll).
  useLayoutEffect(() => {
    if (!open) return;
    const element = list.current;
    const row = element?.querySelector<HTMLElement>(`[id="${optionId(active)}"]`);
    if (!element || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight)
      element.scrollTop = bottom - element.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  // An outside press closes the list (the trigger toggles it itself).
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popup.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', outside, true);
    return () => document.removeEventListener('mousedown', outside, true);
  }, [open]);

  const typeAhead = (key: string, now: number) => {
    const state = typed.current;
    state.text = now - state.at > 700 ? key : state.text + key;
    state.at = now;
    const text = state.text.toLowerCase();
    // One repeated letter cycles through the labels that start with it.
    const repeated = [...text].every((letter) => letter === text[0]);
    const from = open ? active : Math.max(0, selectedIndex);
    const start = repeated ? 1 : 0;
    const needle = repeated ? text[0] : text;
    for (let i = 0; i < options.length; i++) {
      const index = (from + start + i) % options.length;
      if (options[index].label.toLowerCase().startsWith(needle)) return index;
    }
    return -1;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const key = event.key;
    if (!open) {
      if (event.altKey) {
        if (key === 'ArrowDown') {
          event.preventDefault();
          show();
        }
        return;
      }
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault();
        show();
      } else if (key === 'Home' || key === 'End') {
        event.preventDefault();
        show(key === 'Home' ? 0 : options.length - 1);
      } else if (key.length === 1 && key !== ' ') {
        const index = typeAhead(key, event.timeStamp);
        if (index >= 0) {
          event.preventDefault();
          show(index);
        }
      }
      return;
    }
    if (event.altKey) {
      if (key === 'ArrowUp') {
        event.preventDefault();
        choose(active);
      }
      return;
    }
    const page = 10;
    const move = (index: number) => {
      event.preventDefault();
      setActive(Math.max(0, Math.min(options.length - 1, index)));
    };
    if (key === 'ArrowDown') move(active + 1);
    else if (key === 'ArrowUp') move(active - 1);
    else if (key === 'PageDown') move(active + page);
    else if (key === 'PageUp') move(active - page);
    else if (key === 'Home') move(0);
    else if (key === 'End') move(options.length - 1);
    else if (key === 'Enter' || (key === ' ' && !typed.current.text)) {
      event.preventDefault();
      choose(active);
    } else if (key === 'Escape') {
      // Only the list closes; an overlay around it stays open.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (key === 'Tab') setOpen(false);
    else if (key.length === 1) {
      const index = typeAhead(key, event.timeStamp);
      if (index >= 0) move(index);
      else event.preventDefault();
    }
  };
  // A pause ends a type-ahead run, so Space chooses again.
  useEffect(() => {
    if (!open) typed.current = { text: '', at: 0 };
  }, [open]);
  const clearTyped = () => {
    if (typed.current.text && performance.now() - typed.current.at > 700) typed.current.text = '';
  };

  let index = -1;
  const row = (option: PickerOption) => {
    index += 1;
    const at = index;
    return (
      <li
        key={option.id}
        id={optionId(at)}
        role="option"
        aria-selected={option.id === value}
        data-value={option.id}
        data-active={at === active || undefined}
        data-current={option.id === value || undefined}
        className={styles.option}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => at !== active && setActive(at)}
        onClick={() => choose(at)}
      >
        {icons && <FinderIcon icon={option.icon} />}
        <span className={styles.label}>{option.label}</span>
      </li>
    );
  };
  const content: ReactNode = sections.map((section, i) =>
    section.label ? (
      <li key={`s${i}`} role="group" aria-labelledby={`${base}-g${i}`} className={styles.section}>
        <div id={`${base}-g${i}`} role="presentation" className={styles.heading}>
          {section.label}
        </div>
        <ul role="presentation">{section.options.map(row)}</ul>
      </li>
    ) : (
      section.options.map(row)
    ),
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${base}-list` : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        data-value={value}
        title={selected?.label}
        disabled={disabled || !options.length}
        className={[styles.trigger, className].filter(Boolean).join(' ')}
        data-icons={icons || undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          clearTyped();
          onKeyDown(event);
        }}
        onBlur={close}
      >
        {/* The trigger shows an icon only when the value has one (no empty box before "All"). */}
        {icons && selected?.icon && <FinderIcon icon={selected.icon} />}
        <span className={styles.value}>{selected?.label ?? empty ?? ''}</span>
        <span className={styles.chevron} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className={styles.popup}
            data-phone={phone || undefined}
            {...{ [overlayPartAttribute]: '' }}
            // A press on the list (its scrollbar too) keeps focus, and so the list, on the trigger.
            onMouseDown={(event) => event.preventDefault()}
          >
            <ul
              ref={list}
              id={`${base}-list`}
              role="listbox"
              aria-label={label}
              tabIndex={-1}
              className={styles.listbox}
              data-icons={icons || undefined}
            >
              {content}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
});
