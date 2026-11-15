const pauses = new Set<object>();
const resumed = new Set<() => void>();

/**
 * Editor typing quietness: background reply decoding (prefetch of the full Compendium
 * model) waits while text is entered, then resumes at full speed. Priority (pane) replies
 * are never held. Nothing else gates the prefetch, so it still starts at load.
 */
export const EDITOR_INPUT_QUIET_MS = 300;
let inputUntil = 0;
let quietTimer: ReturnType<typeof setTimeout> | undefined;
let watching = false;
const editorTyping = () => quietTimer !== undefined;
const notifyResumed = () => {
  for (const callback of resumed) callback();
};
function quiet() {
  const remaining = inputUntil - performance.now();
  // One timer per typing burst: keys only move the deadline, the timer re-arms itself.
  if (remaining > 0) {
    quietTimer = setTimeout(quiet, remaining);
    return;
  }
  quietTimer = undefined;
  if (!pauses.size) notifyResumed();
}
function editorInput(event: Event) {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest('.cm-content')) return;
  inputUntil = performance.now() + EDITOR_INPUT_QUIET_MS;
  quietTimer ??= setTimeout(quiet, EDITOR_INPUT_QUIET_MS);
}
/** One document listener for every bridge; installed by the first one. */
export function watchEditorInput() {
  if (watching || typeof document === 'undefined' || typeof Element === 'undefined') return;
  watching = true;
  document.addEventListener('beforeinput', editorInput, true);
}

export const backgroundDecodePaused = () => pauses.size > 0 || editorTyping();
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
    if (pauses.delete(owner) && !backgroundDecodePaused()) notifyResumed();
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
