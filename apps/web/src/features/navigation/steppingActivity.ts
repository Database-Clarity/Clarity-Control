import { create } from 'zustand';
import { flushSync } from 'react-dom';

/** Lower-priority sheet/history work waits while editor and preview step live. */
export const useSteppingActivity = create<{
  active: boolean;
  deferWorkspace: boolean;
  target?: string;
}>(() => ({
  active: false,
  deferWorkspace: false,
}));
let previousFrameWork = 0;
let workspaceWork = 0;
let lastInputAt = -Infinity;
let fastInput = false;
let burst = false;
let activityFrame: number | undefined;
let catchUpFrame: number | undefined;
let landLatest: (() => void) | undefined;
const interactionEvents = ['pointerdown', 'keydown', 'beforeinput', 'compositionstart', 'focusin'];
function catchEditorInteraction(event: Event) {
  if (
    event.target instanceof Element &&
    event.target.closest(
      '.cm-editor, section[aria-label*=" editor ("], section[aria-label^="Associations for "]',
    )
  )
    flushSync(settleStepping);
}

/** The frame publishes identity independently of the router's coalesced document render. */
export function publishSteppingTarget(target: string, land: () => void) {
  landLatest = land;
  useSteppingActivity.setState({ target });
}

export function clearSteppingTarget() {
  landLatest = undefined;
  if (useSteppingActivity.getState().target !== undefined)
    useSteppingActivity.setState({ target: undefined });
}

function cancelActivityFrame() {
  if (activityFrame !== undefined) cancelAnimationFrame(activityFrame);
  activityFrame = undefined;
}

function cancelCatchUp() {
  if (catchUpFrame !== undefined) cancelAnimationFrame(catchUpFrame);
  catchUpFrame = undefined;
}

function inputPending() {
  const scheduling = (
    navigator as Navigator & {
      scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
    }
  ).scheduling;
  return scheduling?.isInputPending({ includeContinuous: true }) ?? false;
}

function admissionGap() {
  // A cheap header frame does not make the last expensive document affordable.
  // Keep its cost until a newer document actually commits, or the burst stops.
  return workspaceWork > 16 ? workspaceWork + 8 : 8;
}

/** A fresh packet cancels this handoff, so only the newest route can paint. */
function scheduleCatchUp() {
  if (catchUpFrame !== undefined || typeof requestAnimationFrame !== 'function') return;
  const frame = requestAnimationFrame(() => {
    if (catchUpFrame !== frame) return;
    catchUpFrame = undefined;
    const state = useSteppingActivity.getState();
    if (!state.active || !state.deferWorkspace) return;
    if (inputPending() || performance.now() - lastInputAt < admissionGap()) {
      scheduleCatchUp();
      return;
    }
    const started = performance.now();
    flushSync(() => useSteppingActivity.setState({ deferWorkspace: false }));
    workspaceWork = previousFrameWork = performance.now() - started;
  });
  catchUpFrame = frame;
}
let quiet: ReturnType<typeof setTimeout> | undefined;
const holds = new Set<symbol>();
export function pulseStepping(land?: () => void) {
  const continuing = burst;
  if (!continuing) {
    workspaceWork = previousFrameWork = 0;
    // This temporary capture also covers interaction before the first route
    // frame. Ordinary typing has no listener once the burst has settled.
    for (const type of interactionEvents)
      window.addEventListener(type, catchEditorInteraction, true);
  }
  if (land) landLatest = land;
  burst = true;
  const now = performance.now();
  fastInput = continuing && now - lastInputAt < 12;
  lastInputAt = now;
  cancelCatchUp();
  // Input handlers only record activity. The existing route frame publishes it
  // before landing; clicks and key holds without a route get one fallback frame.
  const state = useSteppingActivity.getState();
  if (activityFrame === undefined && (!state.active || state.deferWorkspace)) {
    const frame = requestAnimationFrame(() => {
      if (activityFrame !== frame) return;
      activityFrame = undefined;
      if (!burst) return;
      if (!useSteppingActivity.getState().active) useSteppingActivity.setState({ active: true });
      if (useSteppingActivity.getState().deferWorkspace) scheduleCatchUp();
    });
    activityFrame = frame;
  }
  clearTimeout(quiet);
  if (!holds.size) quiet = setTimeout(settleStepping, 40);
}

export function settleStepping() {
  burst = false;
  for (const type of interactionEvents)
    window.removeEventListener(type, catchEditorInteraction, true);
  clearTimeout(quiet);
  cancelActivityFrame();
  cancelCatchUp();
  const land = landLatest;
  landLatest = undefined;
  useSteppingActivity.setState({ active: false, deferWorkspace: false });
  land?.();
  clearSteppingTarget();
}

/** Keep input ahead of optional document work, using actual previous-frame cost. */
export function beginSteppingFrame() {
  cancelActivityFrame();
  const started = performance.now();
  const deferWorkspace =
    inputPending() ||
    ((previousFrameWork > 16 || workspaceWork > 16 || fastInput) &&
      started - lastInputAt < admissionGap());
  useSteppingActivity.setState({
    active: true,
    deferWorkspace,
  });
  return () => {
    previousFrameWork = performance.now() - started;
    if (!deferWorkspace) workspaceWork = previousFrameWork;
    if (useSteppingActivity.getState().deferWorkspace) scheduleCatchUp();
  };
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
