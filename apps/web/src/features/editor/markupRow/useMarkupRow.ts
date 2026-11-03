import { useEffect } from 'react';
import { useSettingsStore } from '../../../stores/settings';

/**
 * Whether the markup row is open, and how to flip it. The last choice is remembered on this
 * device; Settings gives the default until then. Ctrl+. (Cmd+. on a Mac) toggles it from anywhere
 * on the page except a text field, where the key may mean something else.
 */
export function useMarkupRow(enabled = true): { open: boolean; toggle(): void } {
  const remembered = useSettingsStore((state) => state.device.remembered.markupToolbar);
  const fallback = useSettingsStore((state) => state.settings.markupToolbar);
  const remember = useSettingsStore((state) => state.remember);
  const open = (remembered ?? fallback) === 'open';
  const toggle = () => remember({ markupToolbar: open ? 'closed' : 'open' });

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '.' || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey)
        return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      )
        return;
      event.preventDefault();
      remember({ markupToolbar: open ? 'closed' : 'open' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled, open, remember]);

  return { open, toggle };
}
