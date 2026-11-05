/** Optional preparation waits through the gaps between an active user's inputs. */
export function reviewPreparationInput() {
  let latest = -Infinity;
  const events = ['keydown', 'beforeinput', 'input', 'pointerdown', 'wheel'] as const;
  const record = () => {
    latest = performance.now();
  };
  if (typeof window !== 'undefined')
    for (const event of events)
      window.addEventListener(event, record, { capture: true, passive: true });
  return {
    pending: () =>
      performance.now() - latest < 150 ||
      ((
        globalThis.navigator as
          | (Navigator & {
              scheduling?: {
                isInputPending(options: { includeContinuous: boolean }): boolean;
              };
            })
          | undefined
      )?.scheduling?.isInputPending({ includeContinuous: true }) ?? false),
    dispose: () => {
      if (typeof window !== 'undefined')
        for (const event of events) window.removeEventListener(event, record, true);
    },
  };
}
