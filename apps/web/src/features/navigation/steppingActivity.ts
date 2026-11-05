import { create } from 'zustand';

/** Lower-priority sheet/history work waits while editor and preview step live. */
export const useSteppingActivity = create<{ active: boolean }>(() => ({ active: false }));
let quiet: ReturnType<typeof setTimeout> | undefined;
const holds = new Set<symbol>();
export function pulseStepping() {
  useSteppingActivity.setState({ active: true });
  clearTimeout(quiet);
  if (!holds.size) quiet = setTimeout(() => useSteppingActivity.setState({ active: false }), 40);
}

/** Physical holds span the OS initial delay and arbitrary key-repeat intervals. */
export function holdSteppingKey(key: string) {
  const token = Symbol(key);
  holds.add(token);
  pulseStepping();
  const release = () => {
    if (!holds.delete(token)) return;
    window.removeEventListener('keyup', changed, true);
    window.removeEventListener('keydown', changed, true);
    window.removeEventListener('blur', release);
    document.removeEventListener('visibilitychange', release);
    pulseStepping();
  };
  const changed = (event: KeyboardEvent) => {
    if (
      (event.type === 'keyup' && event.key === key) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      ['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)
    )
      release();
  };
  window.addEventListener('keyup', changed, true);
  window.addEventListener('keydown', changed, true);
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', release);
  return release;
}
