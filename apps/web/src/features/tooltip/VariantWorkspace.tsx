import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import styles from './TooltipPage.module.scss';
import { useWorkspaceDivider } from './useWorkspaceDivider';

type Panel = 'source' | 'translation' | 'preview';
const panels: { id: Panel; label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'translation', label: 'Editor' },
  { id: 'preview', label: 'Preview' },
];

interface VariantWorkspaceProps {
  /** Present only when editing a non-English language; adds the source panel and tablist. */
  source?: ReactNode;
  editor: ReactNode;
  /**
   * The panel beside the editor. On a phone it is the preview view; on desktop, where the shell
   * shows the preview in its left column, it holds only what stays beside the editor (the
   * Compendium). Null leaves the editor alone: no panel, no tab, no divider.
   */
  preview: ReactNode;
  /** Panel shown first; defaults to the editor. */
  initialPanel?: Panel;
}

/**
 * Lays out source / editor / preview. At the shared mobile breakpoint the tablist shows one panel
 * at a time; hidden panels stay mounted (CSS only) so editor cursor and undo history survive.
 */
export function VariantWorkspace({
  source,
  editor,
  preview,
  initialPanel = 'translation',
}: VariantWorkspaceProps) {
  const hasPreview = preview !== null && preview !== undefined && preview !== false;
  const { container, separator, style, split } = useWorkspaceDivider(hasPreview);
  const prefix = useId();
  const [active, setActive] = useState<Panel>(initialPanel);
  const tabs = useRef<Partial<Record<Panel, HTMLButtonElement | null>>>({});
  const visiblePanels = panels.filter(
    (panel) => (panel.id !== 'source' || source) && (panel.id !== 'preview' || hasPreview),
  );
  const activePanel = visiblePanels.some((panel) => panel.id === active) ? active : 'translation';
  useEffect(() => {
    if (activePanel !== active) setActive(activePanel);
  }, [activePanel, active]);
  const content: Record<Panel, ReactNode> = { source, translation: editor, preview };
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
  return (
    <div className={styles.workspace} ref={container} style={style} data-split={split || undefined}>
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
      {visiblePanels.map(({ id }) => (
        <div
          key={id}
          role="tabpanel"
          id={`${prefix}-panel-${id}`}
          aria-labelledby={`${prefix}-tab-${id}`}
          data-panel={id}
          data-active={activePanel === id}
          className={styles.panel}
        >
          {content[id]}
        </div>
      ))}
      {split && separator}
    </div>
  );
}
