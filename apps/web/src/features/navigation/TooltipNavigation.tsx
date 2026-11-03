import { useCompendiumStore } from '../compendium/store';
import { useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { workspaceShortcutsBlocked } from '../../ui/interaction';
import {
  frameGroupSize,
  itemFor,
  listName,
  navigationGroups,
  sharedPerkLabel,
  variantHashes,
  type CategorySection,
} from './catalog';
import { enhancedPairs } from '../tooltip/variants';
import { EnhancedArrow } from '../../ui/EnhancedArrow';
import {
  categoryPosition,
  createStepping,
  positionLabel,
  createWheelStepper,
  shiftScrollDirection,
  stepTarget,
  tooltipPath,
  type SteppingGuard,
} from './stepping';
import { FinderSheetContext } from './FinderSheetContext';
import styles from './TooltipFinder.module.scss';

// Stepping asks the preview leave guard before it moves anything; see createStepping.
const pathname = (route: string) => route.split('?')[0];
const steppingGuard: SteppingGuard = {
  allow: (from, to) => usePreviewReviewStore.getState().requestLeave(pathname(from), pathname(to)),
  epoch: () => usePreviewReviewStore.getState().epoch,
  authorized: (run) => usePreviewReviewStore.getState().authorized(run),
};

interface Row {
  hash: number;
  name: string;
  /** The perk an exotic armour entry opens, shown beside its hash. */
  perk?: string;
  /** The name already lists several pieces, so the row needs no shared-perk mark. */
  listsPieces?: boolean;
  category: string;
}

/**
 * The editor's finder: category, a searchable tooltip combobox (the selector itself) and the
 * position in the category. Typing filters, arrows move the highlighted option, Enter commits,
 * Escape restores the current item and its query and keeps focus. The highlighted option and
 * the selected (current) one are drawn differently. `bar` is the header form; `sheet` the phone
 * form, which adds Previous/Next because touch screens have no Shift+wheel.
 */
export function TooltipNavigation({
  data,
  variant = 'bar',
}: {
  data: EditorData;
  variant?: 'bar' | 'sheet';
}) {
  const compendiumSource = useCompendiumStore((state) => state.data);
  const sheetOpen = useContext(FinderSheetContext);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [allCategories, setAllCategories] = useState(false);
  const base = useId();
  const listId = `${base}-list`;
  const optionId = (hash: number) => `${base}-o${hash}`;
  const groups = useMemo(() => navigationGroups(data, ''), [data]);
  const found = useMemo(
    () => (query.trim() ? navigationGroups(data, query) : groups),
    [data, groups, query],
  );
  const drafts = useDraftStore((state) => state.drafts);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const location = useLocation();
  const hash = Number(location.pathname.split('/')[2]);
  const sections = groups.flatMap((group) => group.sections);
  const selectedCategory =
    sections.find((category) => category.id === itemFor(hash, data)?.categoryId) ?? sections[0];
  const items = selectedCategory?.items ?? [];
  const hashes = items.map((item) => item.hash);
  const position = categoryPosition(hash, hashes);
  const current = useRef({ pathname: location.pathname, search: location.search });
  current.current = { pathname: location.pathname, search: location.search };
  const field = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [stepping] = useState(() =>
    createStepping((target, options) => navigateRef.current(target, options), steppingGuard),
  );
  const [wheelStepper] = useState(createWheelStepper);
  const step = useRef<(direction: number) => boolean>(() => false);
  const canStep = useRef<(direction: number) => boolean>(() => false);
  step.current = (direction) => {
    const target = stepTarget(current.current, direction, hashes);
    if (!target) return false;
    // Refused before anything moves: the selection, the pending history entry and the timer stay.
    if (!stepping.step(target.from, target.to.path)) return false;
    current.current = target.to;
    return true;
  };
  canStep.current = (direction) => Boolean(stepTarget(current.current, direction, hashes));

  // The list: the current category by default, every category on request.
  const scoped: CategorySection[] = useMemo(() => {
    const all = found.flatMap((group) => group.sections);
    return allCategories || !selectedCategory
      ? all
      : all.filter((section) => section.id === selectedCategory.id);
  }, [found, allCategories, selectedCategory]);
  const rows: Row[] = useMemo(
    () =>
      scoped.flatMap((section) =>
        section.items.map((item) => ({
          hash: item.hash,
          // The row names the piece and keeps the perk on the right, so a set's rows stay
          // tellable apart even where the name column truncates.
          name: item.piece ?? item.name,
          perk:
            item.perkName && item.perkName !== (item.piece ?? item.name)
              ? item.perkName
              : undefined,
          listsPieces: (item.pieces ?? 1) > 1,
          category: section.label,
        })),
      ),
    [scoped],
  );
  const currentItem = itemFor(hash, data);
  const currentLabel = currentItem ? listName(currentItem, data) : '';
  const sharedLabel = sharedPerkLabel(hash, data, compendiumSource);
  const dirty = variantHashes(hash, data).some((variant) => drafts[variant]);

  // A new route, or leaving the field, restores the current item and an empty query.
  const restore = () => {
    setOpen(false);
    setQuery('');
    setAllCategories(false);
  };
  useEffect(() => {
    setOpen(false);
    setQuery('');
    setAllCategories(false);
  }, [location.pathname]);
  // The phone sheet shows the list as soon as it opens, and starts clean when it closes.
  useEffect(() => {
    if (variant !== 'sheet') return;
    if (sheetOpen) setOpen(true);
    else {
      setOpen(false);
      setQuery('');
      setAllCategories(false);
    }
  }, [variant, sheetOpen]);
  useEffect(() => {
    if (!open) return;
    const index = rows.findIndex((row) => row.hash === hash);
    setActive(query.trim() ? 0 : Math.max(0, index));
    // Only a new query, scope or opening resets the highlight; route changes close the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, allCategories]);
  useEffect(() => {
    if (!open) return;
    const row = rows[active];
    if (row) document.getElementById(optionId(row.hash))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, rows]);

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY || event.ctrlKey || event.metaKey || event.shiftKey) return;
      // An open list scrolls itself; the wheel steps only over the closed field.
      if (openRef.current) return;
      event.preventDefault();
      const direction = wheelStepper.feed(event, event.timeStamp);
      if (direction) step.current(direction);
    };
    const shiftWheel = (event: WheelEvent) => {
      const direction = shiftScrollDirection(event);
      if (!direction || workspaceShortcutsBlocked(event)) return;
      if (!canStep.current(direction)) return;
      event.preventDefault();
      const stepDirection = wheelStepper.feed(event, event.timeStamp);
      if (stepDirection) step.current(stepDirection);
    };
    const pop = () => stepping.cancel();
    const change = (event: Event) => {
      if (event.target instanceof HTMLSelectElement) stepping.commit();
    };
    const explicit = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return;
      if (event.target instanceof Element && event.target.closest('a[href]')) stepping.commit();
    };
    element.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('wheel', shiftWheel, { passive: false, capture: true });
    window.addEventListener('popstate', pop);
    document.addEventListener('click', explicit, true);
    document.addEventListener('change', change, true);
    return () => {
      element.removeEventListener('wheel', wheel);
      window.removeEventListener('wheel', shiftWheel, true);
      window.removeEventListener('popstate', pop);
      document.removeEventListener('click', explicit, true);
      document.removeEventListener('change', change, true);
      stepping.cancel();
    };
  }, [stepping, wheelStepper]);
  function choose(target: number) {
    stepping.commit();
    navigate(tooltipPath(target, location.search));
  }
  function commit(row: Row | undefined) {
    if (!row) return;
    restore();
    // A refused (guarded) navigation leaves the route; the field shows the current item again.
    choose(row.hash);
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      if (!open && !query) return;
      // Restore the current item and its query; the focus stays in the field.
      event.preventDefault();
      event.stopPropagation();
      restore();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) {
      if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'F4') {
      event.preventDefault();
      setOpen((value) => !value);
      return;
    }
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Closed, the arrows keep stepping through the category, as the dropdown always did.
        event.preventDefault();
        if (!event.shiftKey) step.current(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length)
        setActive(
          (value) => (value + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length,
        );
    } else if (event.key === 'Home' || event.key === 'End') {
      if (event.shiftKey) return;
      // Home/End move the highlight only while the query is empty; otherwise they edit the text.
      if (query) return;
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : Math.max(0, rows.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (rows.length) commit(rows[active]);
      else if (query.trim() && !allCategories) setAllCategories(true);
    }
  };

  const option = (row: Row) => {
    const index = rows.indexOf(row);
    const item = itemFor(row.hash, data);
    const isDirty = variantHashes(row.hash, data).some((variant) => drafts[variant]);
    const shared = sharedPerkLabel(row.hash, data, compendiumSource);
    const frames = frameGroupSize(row.hash, data);
    const enhanced = enhancedPairs(row.hash, data).length > 0;
    return (
      <li
        key={row.hash}
        id={optionId(row.hash)}
        role="option"
        aria-selected={row.hash === hash}
        data-active={index === active || undefined}
        data-current={row.hash === hash || undefined}
        title={shared}
        className={styles.option}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => index !== active && setActive(index)}
        onClick={() => commit(row)}
      >
        <span className={styles.mark} aria-hidden="true">
          {isDirty ? '*' : ''}
        </span>
        <span className={styles.name}>
          {isDirty && <span className="sr-only">Unsaved draft: </span>}
          {row.name}
        </span>
        <small>
          {enhanced && (
            <span className={styles.enhanced} title="Has an enhanced version">
              <EnhancedArrow />
            </span>
          )}
          {row.perk && `${row.perk} · `}
          {row.hash}
          {shared && !row.listsPieces && ' · shared perk'}
          {frames > 1 && ` ×${frames}`}
          {item && allCategories && ` · ${row.category}`}
        </small>
      </li>
    );
  };
  const trimmed = query.trim();
  const listbox = open && (
    <div className={styles.popup} data-variant={variant}>
      <ul id={listId} role="listbox" aria-label="Tooltips" className={styles.listbox}>
        {rows.map(option)}
      </ul>
      {!rows.length && (
        <p className={styles.empty}>
          No tooltips match “{trimmed}”
          {!allCategories && selectedCategory ? ` in ${selectedCategory.label}` : ''}.
          {!allCategories && (
            <>
              {' '}
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setAllCategories(true)}
              >
                Search all categories
              </button>
            </>
          )}{' '}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setQuery('');
              setAllCategories(false);
            }}
          >
            Clear
          </button>
        </p>
      )}
      {rows.length > 0 && trimmed && !allCategories && (
        <button
          type="button"
          className={styles.widen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setAllCategories(true)}
        >
          Search all categories
        </button>
      )}
    </div>
  );
  const sheet = variant === 'sheet';
  const categoryNode = (
    <select
      aria-label="Category"
      className={styles.category}
      value={selectedCategory?.id ?? ''}
      disabled={!sections.length}
      onChange={(event) => {
        const first = sections.find((category) => category.id === event.target.value)?.items[0];
        if (first) choose(first.hash);
      }}
    >
      {!sections.length && <option value="">No matching categories</option>}
      {groups.map((group) => (
        <optgroup key={group.name} label={group.name}>
          {group.sections.map((category) => (
            <option key={category.id} value={category.id}>
              {category.label} ({category.items.length})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
  const positionNode = (
    <span className={styles.position} role="status">
      {positionLabel(position)}
    </span>
  );
  const comboNode = (
    <div
      ref={root}
      className={styles.combo}
      onBlur={(event) => {
        // The sheet keeps its list open while the sheet is; only the header form closes on blur.
        if (!sheet && !event.currentTarget.contains(event.relatedTarget)) restore();
      }}
    >
      <div className={styles.field}>
        <input
          ref={field}
          type="text"
          role="combobox"
          aria-label="Tooltip"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && rows[active] ? optionId(rows[active].hash) : undefined}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-describedby="tooltip-stepping-help"
          autoComplete="off"
          spellCheck={false}
          className={styles.input}
          title={sharedLabel}
          placeholder={open ? currentLabel : 'Find a tooltip'}
          value={open ? query : currentLabel}
          disabled={!items.length && !found.length}
          onFocus={(event) => event.currentTarget.select()}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {dirty && <span className={styles.draftDot} role="img" aria-label="Unsaved draft" />}
      </div>
      {listbox}
      <span role="status" className="sr-only">
        {open ? `${rows.length} tooltip${rows.length === 1 ? '' : 's'}` : ''}
      </span>
    </div>
  );
  return (
    <section aria-label="Tooltip navigation" className={styles.finder} data-variant={variant}>
      {sheet ? (
        <>
          {comboNode}
          <div className={styles.sheetBar}>
            {categoryNode}
            {/* Touch screens have no Shift+wheel: one compact row steps through the category. */}
            <div role="group" aria-label="Step within category" className={styles.stepper}>
              <button
                type="button"
                aria-label="Previous tooltip"
                disabled={position.previous === undefined}
                onClick={() => step.current(-1)}
              >
                ‹
              </button>
              {positionNode}
              <button
                type="button"
                aria-label="Next tooltip"
                disabled={position.next === undefined}
                onClick={() => step.current(1)}
              >
                ›
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          {categoryNode}
          {comboNode}
          {positionNode}
        </>
      )}
      {sharedLabel && (
        <small role="note" className={sheet ? styles.note : 'sr-only'}>
          {sharedLabel}
        </small>
      )}
      <small id="tooltip-stepping-help" className="sr-only">
        Type to search. Shift+Scroll anywhere steps within this category and stops at its ends; the
        arrow keys step too while the list is closed. * = unsaved draft.
      </small>
    </section>
  );
}
