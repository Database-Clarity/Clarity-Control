import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { phoneQuery, useMedia } from '../../ui/useMedia';
import styles from './TooltipPage.module.scss';
import { useWorkspaceDivider } from './useWorkspaceDivider';

type Panel = 'source' | 'translation' | 'preview' | 'compendium';
const panels: { id: Panel; label: string; toggle: boolean }[] = [
  { id: 'translation', label: 'Editor', toggle: false },
  { id: 'preview', label: 'Preview', toggle: true },
  { id: 'source', label: 'English', toggle: true },
  { id: 'compendium', label: 'Compendium', toggle: true },
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
  /** Panel shown first on a phone, or in the swapped slot; defaults to the editor. */
  initialPanel?: Panel;
}

const present = (node: ReactNode) => node !== null && node !== undefined && node !== false;

/**
 * Lays out the editor with its pane header and what sits beside it. Three modes, by room:
 * - split (the editor keeps 480px beside a 320px+ pane): editor | divider | Compendium, as before;
 * - toggle (a desktop window too narrow for that): the pane header gets "Compendium" / "English"
 *   buttons that swap the main slot instead of stacking the pane under the editor;
 * - phone (<= 700px): a 44px tablist (Editor / Preview / English / Compendium), one view at a time.
 * Hidden panels stay mounted (CSS only), so editor cursor and undo history survive every switch.
 */
export function VariantWorkspace({
  header,
  source,
  editor,
  preview,
  compendium,
  initialPanel = 'translation',
}: VariantWorkspaceProps) {
  const phone = useMedia(phoneQuery);
  const hasSide = present(preview) || present(compendium);
  const { container, separator, style, split } = useWorkspaceDivider(hasSide);
  const mode = phone ? 'phone' : split ? 'split' : 'toggle';
  const prefix = useId();
  const [active, setActive] = useState<Panel>(initialPanel);
  const tabs = useRef<Partial<Record<Panel, HTMLButtonElement | null>>>({});
  const content: Record<Panel, ReactNode> = {
    source,
    translation: editor,
    preview,
    compendium,
  };
  const visiblePanels = panels.filter(
    (panel) => panel.id === 'translation' || present(content[panel.id]),
  );
  const activePanel = visiblePanels.some((panel) => panel.id === active) ? active : 'translation';
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
    setActive(next);
    tabs.current[next]?.focus();
  }
  // The pane header's buttons swap the main slot (toggle mode); a phone has the tablist instead.
  const toggles = visiblePanels.filter(({ id, toggle }) => toggle && present(content[id]));
  // Split mode shows every panel; toggle and phone show the active one.
  const isActive = (id: Panel) => mode === 'split' || activePanel === id;
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
        {content[id]}
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
            onClick={() => setActive(id)}
          >
            {label}
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
                onClick={() => setActive(activePanel === id ? 'translation' : id)}
              >
                {label}
              </button>
            ))}
          </span>
        )}
      </div>
      {panel('source')}
      {panel('translation')}
      <div className={styles.side}>
        {panel('preview')}
        {panel('compendium')}
      </div>
      {split && separator}
    </div>
  );
}
