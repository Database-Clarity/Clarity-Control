import { languageLabel } from '../../languageLabels';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { resolveAlias } from '@clarity/core';
import type { EditorData } from '../../stores/data';
import { useDraftStore } from '../../stores/drafts';
import {
  frameGroupSize,
  itemFor,
  navigationGroups,
  sharedPerkLabel,
  variantHashes,
} from './catalog';
import {
  categoryPosition,
  createStepping,
  positionLabel,
  shiftScrollDirection,
  stepTarget,
  tooltipPath,
} from './stepping';
import styles from './Layout.module.scss';

export function TooltipNavigation({ data }: { data: EditorData }) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => navigationGroups(data, query), [data, query]);
  const drafts = useDraftStore((state) => state.drafts);
  const discard = useDraftStore((state) => state.discard);
  const staleDrafts = Object.entries(drafts).filter(
    ([hash]) => resolveAlias(Number(hash), data.aliases) !== Number(hash),
  );
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
  const select = useRef<HTMLSelectElement>(null);
  const [stepping] = useState(() =>
    createStepping((target, options) => navigateRef.current(target, options)),
  );
  const step = useRef<(direction: number) => boolean>(() => false);
  step.current = (direction) => {
    const target = stepTarget(current.current, direction, hashes);
    if (!target) return false;
    stepping.step(target.from, target.to.path);
    current.current = target.to;
    return true;
  };
  useEffect(() => {
    const element = select.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      step.current(Math.sign(event.deltaY));
    };
    const shiftWheel = (event: WheelEvent) => {
      const direction = shiftScrollDirection(event);
      if (!direction) return;
      if (step.current(direction)) event.preventDefault();
    };
    const pop = () => stepping.cancel();
    const change = (event: Event) => {
      if (event.target instanceof HTMLSelectElement && event.target !== element) stepping.commit();
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
  }, [stepping]);
  function choose(hash: number) {
    stepping.commit();
    navigate(tooltipPath(hash, location.search));
  }
  return (
    <>
      <section aria-label="Tooltip navigation" className={styles.tooltipNavigation}>
        {staleDrafts.map(([hash, draft]) => {
          const canonical = resolveAlias(Number(hash), data.aliases);
          return (
            <details key={hash}>
              <summary role="alert">
                Recovered draft conflict: {hash} now shares tooltip {canonical}
              </summary>
              <p>
                This draft is preserved, but cannot be saved separately. Copy any text you want to
                keep into the shared tooltip before discarding it.
              </p>
              <button type="button" onClick={() => choose(canonical)}>
                Open shared tooltip {canonical}
              </button>
              {Object.entries(draft.next.text).map(([language, value]) => (
                <div key={language}>
                  <strong>{languageLabel(language)}</strong>
                  <pre className={styles.recoveredText}>{value.text}</pre>
                </div>
              ))}
              <button type="button" onClick={() => discard(Number(hash))}>
                Discard recovered draft {hash}
              </button>
            </details>
          );
        })}
        <label>
          Search name or hash
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label>
          Category
          <select
            value={selectedCategory?.id ?? ''}
            disabled={!sections.length}
            onChange={(event) => {
              const first = sections.find((category) => category.id === event.target.value)
                ?.items[0];
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
        </label>
        <label>
          Tooltip
          <select
            ref={select}
            value={items.some((item) => item.hash === hash) ? String(hash) : ''}
            disabled={!items.length}
            aria-describedby="tooltip-stepping-help"
            onChange={(event) => choose(Number(event.target.value))}
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                step.current(event.key === 'ArrowDown' ? 1 : -1);
              }
            }}
          >
            <option value="" disabled>
              {items.length ? 'Choose tooltip' : 'No matching tooltips'}
            </option>
            {items.map((item) => {
              const dirty = variantHashes(item.hash, data).some((variant) => drafts[variant]);
              return (
                <option key={item.hash} value={item.hash} title={sharedPerkLabel(item.hash, data)}>
                  {dirty ? '* ' : ''}
                  {item.name} ({item.hash}){sharedPerkLabel(item.hash, data) && ' · shared perk'}
                  {frameGroupSize(item.hash, data) > 1 && ` ×${frameGroupSize(item.hash, data)}`}
                </option>
              );
            })}
          </select>
        </label>
        {sharedPerkLabel(hash, data) && <small role="note">{sharedPerkLabel(hash, data)}</small>}
        <small id="tooltip-stepping-help">
          <span className={styles.pointerHelp}>
            Shift+Scroll anywhere steps within this category and stops at its ends. Arrow keys on
            Tooltip also work.{' '}
          </span>
          * = unsaved draft.
        </small>
      </section>
      {/* A direct child of the sidebar so the phone layout can keep it visible while Browse is closed. */}
      <div role="group" aria-label="Step within category" className={styles.stepper}>
        <button
          type="button"
          disabled={position.previous === undefined}
          onClick={() => step.current(-1)}
        >
          Previous
        </button>
        <span role="status">{positionLabel(position)}</span>
        <button
          type="button"
          disabled={position.next === undefined}
          onClick={() => step.current(1)}
        >
          Next
        </button>
      </div>
    </>
  );
}
