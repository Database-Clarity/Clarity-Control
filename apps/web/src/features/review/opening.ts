import { create } from 'zustand';

interface OpeningState {
  token: number;
  warming: boolean;
  limit: number;
  required: number;
}

export const useReviewOpening = create<OpeningState>(() => ({
  token: 0,
  warming: false,
  limit: Number.POSITIVE_INFINITY,
  required: 0,
}));

let mountedPages = 0;

export function beginReviewOpening() {
  if (mountedPages) return;
  if (typeof window === 'undefined' || !window.requestAnimationFrame) return;
  useReviewOpening.setState((state) => ({
    token: state.token + 1,
    warming: true,
    limit: 0,
    required: 0,
  }));
}

export function retainReviewPage() {
  mountedPages++;
  let retained = true;
  return () => {
    if (retained) mountedPages--;
    retained = false;
  };
}

export function requireReviewRows(required: number) {
  if (useReviewOpening.getState().required !== required) useReviewOpening.setState({ required });
}

/** Called after a paint. Activation waits for the last slice's paint too. */
export function advanceReviewOpening(token: number) {
  const state = useReviewOpening.getState();
  if (state.token !== token || !state.warming) return true;
  if (state.limit < state.required) {
    useReviewOpening.setState({ limit: Math.min(state.required, state.limit + 4) });
    return false;
  }
  useReviewOpening.setState({ warming: false });
  return true;
}
