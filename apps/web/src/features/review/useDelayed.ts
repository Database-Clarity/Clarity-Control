import { useEffect, useState } from 'react';

/** Review's skeleton rule (spec §9): show only after 150 ms of real waiting, never held after. */
export const skeletonDelayMs = 150;

/** True once `waiting` has lasted `ms`; false the moment it ends. */
export function useDelayed(waiting: boolean, ms = skeletonDelayMs): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setLate(false);
      return;
    }
    const timer = window.setTimeout(() => setLate(true), ms);
    return () => window.clearTimeout(timer);
  }, [waiting, ms]);
  return waiting && late;
}
