import { create } from 'zustand';

/** Expensive workspace panels mount only after a wheel/key burst stops. */
export const useSteppingActivity = create<{ active: boolean }>(() => ({ active: false }));
let quiet: ReturnType<typeof setTimeout> | undefined;
export function pulseStepping() {
  useSteppingActivity.setState({ active: true });
  clearTimeout(quiet);
  quiet = setTimeout(() => useSteppingActivity.setState({ active: false }), 40);
}
