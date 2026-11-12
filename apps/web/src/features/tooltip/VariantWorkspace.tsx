import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useSettingsStore } from '../../stores/settings';
import { RightPaneTabsContext, type RightPaneTabs } from '../../ui/RightPane';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import styles from './TooltipPage.module.scss';
import { useWorkspaceDivider } from './useWorkspaceDivider';
import { usePaneStatus } from '../compendium/paneStatus';
import { useReportsTab } from '../reports/pane/tabStore';

type Panel = 'source' | 'translation' | 'preview' | 'compendium' | 'reports';
const panels: { id: Panel; label: string; toggle: boolean }[] = [
  { id: 'translation', label: 'Editor', toggle: false },
  { id: 'preview', label: 'Preview', toggle: true },
  { id: 'source', label: 'English', toggle: true },
  { id: 'compendium', label: 'Compendium', toggle: true },
  { id: 'reports', label: 'Reports', toggle: true },
];

interface VariantWorkspaceProps {
  /** The 28px pane header above the editor (language, draft, read-only, override actions). */
  header?: ReactNode;
  /** Present only when editing a non-English language: the English text the translation follows. */
  source?: ReactNode;
  editor: ReactNode;
  /** The inline preview. Null where the shell's left column already shows it. */
  preview?: ReactNode;
  /** The Compendium comparison beside the editor. Null for translators and archived pages. */
  compendium?: ReactNode;
  compendiumLabel?: string;
  /**
   * The Reports tab, for roles that may see reports: the pane (rendered only while the tab is
   * open) and the open count from the marker index (null while unknown) for its label.
   */
  reports?: { pane: ReactNode; count: number | null };
  /** Panel shown first on a phone, or in the swapped slot; defaults to the editor. */
  initialPanel?: Panel;
  /** Keep pane measurement/tab state stable while a navigation burst hides the workspace. */
  suspended?: boolean;
}

const present = (node: ReactNode) => node !== null && node !== undefined && node !== false;
const sideTabs = [
  { id: 'source', label: 'English' },
  { id: 'compendium', label: 'Compendium' },
  { id: 'reports', label: 'Reports' },
] as const;
const reportsLabel = (count: number | null | undefined) => (count ? `Reports ${count}` : 'Reports');

/**
 * Lays out the editor with its pane header and what sits beside it. Three modes, by room:
 * - split (the editor keeps 480px beside a 320px+ pane): editor | divider | right pane (the
 *   Compendium, or the English a translation follows), each with its own 28px header;
 * - toggle (a desktop window too narrow for that): the pane header gets "Compendium" / "English"
 *   buttons that swap the main slot instead of stacking the pane under the editor;
 * - phone (<= 700px): a 44px tablist (Editor / Preview / English / Compendium), one view at a time.
 * Hidden panels stay mounted (CSS only), so editor cursor and undo history survive every switch.
 *
 * Translate mode with a Compendium (English and Compendium both present): in split mode the right
 * pane shows ONE of them, picked by two tabs in the pane's own header (English first; the pick is
 * remembered on this device). The other is not rendered at all, so a hidden Compendium does no
 * matching, decoding, or layout; it mounts when its tab is opened. Toggle mode likewise renders
 * the Compendium only while it is the open view.
 */
export function VariantWorkspace({
  header,
  source,
  editor,
  preview,
  compendium,
  compendiumLabel = 'Compendium',
  reports,
  initialPanel = 'translation',
  suspended = false,
}: VariantWorkspaceProps) {
  const phone = useMedia(phoneQuery);
  const hasSide = present(preview) || present(compendium) || present(source);
  const { container, separator, style, split } = useWorkspaceDivider(hasSide, suspended);
  const mode = phone ? 'phone' : split ? 'split' : 'toggle';
  const prefix = useId();
  const [active, setActive] = useState<Panel>(initialPanel);
  const paired = present(source) && present(compendium);
  const hasReports = Boolean(reports);
  // The Reports pick is one session value (stepping keeps the tab open); it wins over the
  // remembered English/Compendium pick while it is set.
  const reportsOpen = useReportsTab((state) => state.open) && hasReports;
  const setReportsOpen = useReportsTab((state) => state.setOpen);
  const rememberedPane = useSettingsStore((state) => state.device.remembered.translatePane);
  const remember = useSettingsStore((state) => state.remember);
  const sideTab: Panel = paired && rememberedPane === 'compendium' ? 'compendium' : 'source';
  /** Opening English or the Compendium, in any mode, is the pick the split pane remembers. */
  const open = (id: Panel) => {
    setActive(id);
    if (hasReports) setReportsOpen(id === 'reports');
    if (paired && (id === 'source' || id === 'compendium'))
      remember({ translatePane: id === 'source' ? 'english' : 'compendium' });
  };
  const side = useRef<HTMLDivElement>(null);
  const focusTab = useRef(false);
  // The side views that share the right pane, one at a time, through tabs in its header.
  const hasSource = present(source);
  const hasCompendium = present(compendium);
  const sideKey = [hasSource && 'source', hasCompendium && 'compendium', hasReports && 'reports']
    .filter(Boolean)
    .join(',');
  const sideIds = sideKey ? (sideKey.split(',') as Panel[]) : [];
  const tabbed = sideIds.length > 1 && mode === 'split';
  const sidePick: Panel = reportsOpen
    ? 'reports'
    : paired
      ? sideTab
      : (sideIds.find((id) => id !== 'reports') ?? 'reports');
  const reportCount = reports?.count;
  const paneTabs = useMemo<RightPaneTabs | null>(
    () =>
      tabbed
        ? {
            label: 'Right pane',
            tabs: sideTabs
              .filter((tab) => sideKey.split(',').includes(tab.id))
              .map((tab) =>
                tab.id === 'compendium'
                  ? { ...tab, label: compendiumLabel }
                  : tab.id === 'reports'
                    ? { ...tab, label: reportsLabel(reportCount) }
                    : tab,
              ),
            active: sidePick,
            onSelect(id) {
              // The other pane's header replaces this one: its tab takes the focus over.
              focusTab.current = true;
              setReportsOpen(id === 'reports');
              if (paired && id !== 'reports')
                remember({ translatePane: id === 'source' ? 'english' : 'compendium' });
            },
          }
        : null,
    [tabbed, sideKey, sidePick, remember, compendiumLabel, reportCount, paired, setReportsOpen],
  );
  useLayoutEffect(() => {
    if (!focusTab.current) return;
    focusTab.current = false;
    side.current?.querySelector<HTMLElement>('[data-pane-tab][aria-selected="true"]')?.focus();
  }, [sidePick]);
  // Alt+R opens the Reports tab and focuses its first report (Ctrl+Shift+R is the browser's).
  const openAndFocus = useReportsTab((state) => state.openAndFocus);
  useEffect(() => {
    if (!hasReports) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.code !== 'KeyR' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      openAndFocus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasReports, openAndFocus]);
  const tabs = useRef<Partial<Record<Panel, HTMLButtonElement | null>>>({});
  const content: Record<Panel, ReactNode> = {
    source,
    translation: editor,
    preview,
    compendium,
    reports: reports?.pane,
  };
  // A dot on the Compendium tab: matched or linked text, or an entry that needs a decision.
  const compendiumStatus = usePaneStatus((state) => state.status);
  const visiblePanels = panels
    .map((panel) =>
      panel.id === 'compendium'
        ? { ...panel, label: compendiumLabel }
        : panel.id === 'reports'
          ? { ...panel, label: reportsLabel(reportCount) }
          : panel,
    )
    .filter((panel) => panel.id === 'translation' || present(content[panel.id]));
  // Toggle and phone: the Reports pick (kept across steps, set by Alt+R) shows Reports; leaving
  // it for another view clears the pick.
  const wanted: Panel = reportsOpen ? 'reports' : active === 'reports' ? 'translation' : active;
  const activePanel = visiblePanels.some((panel) => panel.id === wanted) ? wanted : 'translation';
  useEffect(() => {
    if (activePanel !== active) setActive(activePanel);
  }, [activePanel, active]);
  function onKeyDown(event: KeyboardEvent) {
    const index = visiblePanels.findIndex((panel) => panel.id === activePanel);
    const target =
      event.key === 'ArrowRight'
        ? (index + 1) % visiblePanels.length
        : event.key === 'ArrowLeft'
          ? (index + visiblePanels.length - 1) % visiblePanels.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? visiblePanels.length - 1
              : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = visiblePanels[target].id;
    open(next);
    tabs.current[next]?.focus();
  }
  // The pane header's buttons swap the main slot (toggle mode); a phone has the tablist instead.
  const toggles = visiblePanels.filter(({ id, toggle }) => toggle && present(content[id]));
  // Split mode shows every panel (of English and Compendium, the picked one); toggle and phone
  // show the active one.
  const hiddenTab = (id: Panel) => tabbed && sideIds.includes(id) && id !== sidePick;
  const isActive = (id: Panel) => (mode === 'split' ? !hiddenTab(id) : activePanel === id);
  // Not rendered at all: the tab that is not open, and in toggle mode (also the first render,
  // before the width is measured) and on a phone a Compendium that is not the open view. Its
  // tab's dot is the pane's own result, so it shows only while the pane is open: a hidden pane
  // never matches or decodes for it, and never shows the previous tooltip's.
  // Reports likewise exists only while it is the open view: a closed tab costs nothing.
  const unmounted = (id: Panel) =>
    hiddenTab(id) ||
    (paired && mode !== 'split' && id === 'compendium' && activePanel !== 'compendium') ||
    (id === 'reports' && (mode === 'split' ? sidePick !== 'reports' : activePanel !== 'reports'));
  const panel = (id: Panel) =>
    present(content[id]) || id === 'translation' ? (
      <div
        key={id}
        role="tabpanel"
        id={`${prefix}-panel-${id}`}
        aria-labelledby={`${prefix}-tab-${id}`}
        data-panel={id}
        data-active={isActive(id)}
        className={styles.panel}
      >
        {unmounted(id) ? null : content[id]}
      </div>
    ) : null;
  return (
    <div
      className={styles.workspace}
      ref={container}
      style={style}
      data-split={split || undefined}
      data-mode={mode}
      data-view={activePanel}
    >
      <div role="tablist" aria-label="Tooltip panels" className={styles.tabs} onKeyDown={onKeyDown}>
        {visiblePanels.map(({ id, label }) => (
          <button
            key={id}
            ref={(element) => {
              tabs.current[id] = element;
            }}
            type="button"
            role="tab"
            id={`${prefix}-tab-${id}`}
            aria-selected={activePanel === id}
            aria-controls={`${prefix}-panel-${id}`}
            tabIndex={activePanel === id ? 0 : -1}
            aria-label={
              id === 'reports' && reportCount ? `Reports, ${reportCount} open` : undefined
            }
            onClick={() => open(id)}
          >
            <span className={styles.tabLabel}>{label}</span>
            {id === 'compendium' && compendiumStatus && !unmounted(id) && (
              <span
                className={styles.statusDot}
                data-status={compendiumStatus}
                role="img"
                aria-label={compendiumStatus === 'review' ? 'Needs review' : 'Matched'}
              />
            )}
          </button>
        ))}
      </div>
      <div className={styles.paneHeader} role="group" aria-label="Editor tools">
        {header}
        {toggles.length > 0 && (
          <span className={styles.paneToggles} data-toggles>
            {toggles.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={activePanel === id}
                onClick={() => open(activePanel === id ? 'translation' : id)}
              >
                {label}
              </button>
            ))}
          </span>
        )}
      </div>
      {panel('translation')}
      <div className={styles.side} ref={side}>
        <RightPaneTabsContext.Provider value={paneTabs}>
          {panel('source')}
          {panel('preview')}
          {panel('compendium')}
          {panel('reports')}
        </RightPaneTabsContext.Provider>
      </div>
      {split && separator}
    </div>
  );
}
