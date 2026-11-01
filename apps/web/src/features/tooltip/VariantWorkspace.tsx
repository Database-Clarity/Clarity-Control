import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import styles from './TooltipPage.module.scss';

type Panel = 'source' | 'translation' | 'preview';
const panels: { id: Panel; label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'translation', label: 'Translation' },
  { id: 'preview', label: 'Preview' },
];

interface VariantWorkspaceProps {
  /** Present only when editing a non-English language; adds the source panel and tablist. */
  source?: ReactNode;
  editor: ReactNode;
  preview: ReactNode;
}

/**
 * Lays out source / editor / preview. At the shared mobile breakpoint the tablist shows one panel
 * at a time; hidden panels stay mounted (CSS only) so editor cursor and undo history survive.
 */
export function VariantWorkspace({ source, editor, preview }: VariantWorkspaceProps) {
  const prefix = useId();
  const [active, setActive] = useState<Panel>('translation');
  const tabs = useRef<Partial<Record<Panel, HTMLButtonElement | null>>>({});
  if (!source) {
    return (
      <div className={styles.columns}>
        {editor}
        {preview}
      </div>
    );
  }
  const content: Record<Panel, ReactNode> = { source, translation: editor, preview };
  function onKeyDown(event: KeyboardEvent) {
    const index = panels.findIndex((panel) => panel.id === active);
    const target =
      event.key === 'ArrowRight'
        ? (index + 1) % panels.length
        : event.key === 'ArrowLeft'
          ? (index + panels.length - 1) % panels.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? panels.length - 1
              : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = panels[target].id;
    setActive(next);
    tabs.current[next]?.focus();
  }
  return (
    <div className={styles.workspace}>
      <div role="tablist" aria-label="Tooltip panels" className={styles.tabs} onKeyDown={onKeyDown}>
        {panels.map(({ id, label }) => (
          <button
            key={id}
            ref={(element) => {
              tabs.current[id] = element;
            }}
            type="button"
            role="tab"
            id={`${prefix}-tab-${id}`}
            aria-selected={active === id}
            aria-controls={`${prefix}-panel-${id}`}
            tabIndex={active === id ? 0 : -1}
            onClick={() => setActive(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {panels.map(({ id }) => (
        <div
          key={id}
          role="tabpanel"
          id={`${prefix}-panel-${id}`}
          aria-labelledby={`${prefix}-tab-${id}`}
          data-panel={id}
          data-active={active === id}
          className={styles.panel}
        >
          {content[id]}
        </div>
      ))}
    </div>
  );
}
