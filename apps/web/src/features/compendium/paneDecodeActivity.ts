const pauses = new Set<object>();
const resumed = new Set<() => void>();

export const backgroundDecodePaused = () => pauses.size > 0;
export function onBackgroundDecodeResume(callback: () => void) {
  resumed.add(callback);
  return () => resumed.delete(callback);
}

/** Only hydrated panes hold this: source bootstrap must still be able to finish. */
export function createPaneDecodeGuard() {
  const owner = {};
  let target: number | undefined;
  let generation = 0;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    frame = timer = undefined;
    generation++;
  };
  const release = () => {
    if (pauses.delete(owner) && !pauses.size) for (const callback of resumed) callback();
  };
  return {
    begin(hash: number) {
      if (hash === target) return;
      cancel();
      target = hash;
      pauses.add(owner);
    },
    committed(hash: number) {
      if (hash !== target || !pauses.has(owner) || frame !== undefined || timer !== undefined)
        return;
      const current = generation;
      // Let the committed pane's paint opportunity precede background tasks.
      frame = requestAnimationFrame(() => {
        if (generation !== current) return;
        frame = undefined;
        timer = setTimeout(() => {
          timer = undefined;
          if (generation === current) release();
        }, 0);
      });
    },
    dispose() {
      cancel();
      target = undefined;
      release();
    },
  };
}
