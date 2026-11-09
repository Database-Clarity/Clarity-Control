import { create } from 'zustand';

/** Pause after a decision before the queue moves on, on this device (ms; 0 = move at once). */
export const advanceChoices = [0, 300, 600, 1000, 2000] as const;
export const defaultAdvanceMs = 600;
export const advanceKey = 'clarity-compendium-advance-ms';

export function parseAdvance(value: unknown): number {
  const number = typeof value === 'string' ? Number(value) : value;
  return advanceChoices.find((choice) => choice === number) ?? defaultAdvanceMs;
}

function read(): number {
  try {
    return parseAdvance(localStorage.getItem(advanceKey));
  } catch {
    return defaultAdvanceMs;
  }
}

interface AdvanceState {
  ms: number;
  set(ms: number): void;
}
export const useAdvanceSetting = create<AdvanceState>((set) => ({
  ms: read(),
  set(ms) {
    const value = parseAdvance(ms);
    set({ ms: value });
    try {
      localStorage.setItem(advanceKey, String(value));
    } catch {
      // The choice still applies for this visit.
    }
  },
}));
