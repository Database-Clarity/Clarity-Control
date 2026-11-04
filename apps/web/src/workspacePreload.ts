export type WorkspaceLoader = () => Promise<unknown>;

export function allowBackgroundCode(): boolean {
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string; downlink?: number };
    }
  ).connection;
  return (
    !!window.requestIdleCallback &&
    !connection?.saveData &&
    !/^(slow-2g|2g|3g)$/.test(connection?.effectiveType ?? '') &&
    // effectiveType already combines network estimates; don't classify a reported 4G
    // connection twice using its rounded downlink value.
    (connection?.effectiveType !== undefined ||
      connection?.downlink === undefined ||
      connection.downlink >= 1.5)
  );
}

/** Code only; one route per idle turn, in the role's ordinary workspace order. */
export function preloadWorkspaces(loaders: readonly WorkspaceLoader[]): () => void {
  if (!allowBackgroundCode()) return () => {};

  let cancelled = false;
  let idle: number | undefined;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let index = 0;
  let frame = 0;
  const observer = new MutationObserver(() => schedule());
  const inputEvents = ['keydown', 'pointerdown', 'wheel', 'input', 'touchstart'] as const;
  const ready = () => {
    if (document.hidden || document.querySelector('main [aria-busy="true"]')) return false;
    const main = document.querySelector('main');
    return (
      !!main &&
      ![...main.querySelectorAll('[role="status"]')].some((node) =>
        /loading|opening|matching|comparing publishable/i.test(node.textContent ?? ''),
      )
    );
  };
  function schedule() {
    if (cancelled || busy || quiet !== undefined || idle !== undefined || index >= loaders.length)
      return;
    idle = window.requestIdleCallback((deadline) => {
      idle = undefined;
      if (cancelled) return;
      if (!ready()) {
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        return;
      }
      observer.disconnect();
      const scheduling = (
        navigator as Navigator & {
          scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean };
        }
      ).scheduling;
      if (deadline.timeRemaining() < 8 || scheduling?.isInputPending({ includeContinuous: true })) {
        schedule();
        return;
      }
      busy = true;
      // Background scheduling gives pending input precedence. An in-flight module download
      // cannot be cancelled; after it finishes, input must become quiet before another starts.
      const scheduler = (
        globalThis as typeof globalThis & {
          scheduler?: {
            postTask<T>(run: () => T, options: { priority: 'background' }): Promise<Awaited<T>>;
          };
        }
      ).scheduler;
      const load = loaders[index++]!;
      const run = () => {
        if (cancelled) return;
        if (quiet !== undefined || scheduling?.isInputPending({ includeContinuous: true })) {
          index--;
          pause();
          return;
        }
        return load();
      };
      const pending = scheduler
        ? scheduler.postTask(run, { priority: 'background' })
        : Promise.resolve().then(run);
      void pending
        .catch(() => {})
        .finally(() => {
          busy = false;
          schedule();
        });
    });
  }
  const pause = () => {
    if (idle !== undefined) window.cancelIdleCallback(idle);
    idle = undefined;
    if (quiet !== undefined) clearTimeout(quiet);
    quiet = setTimeout(() => {
      quiet = undefined;
      schedule();
    }, 250);
  };
  for (const event of inputEvents)
    window.addEventListener(event, pause, { passive: true, capture: true });
  document.addEventListener('visibilitychange', schedule);
  // The first workspace must get a complete paint before background imports can begin.
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(schedule);
  });
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    if (idle !== undefined) window.cancelIdleCallback(idle);
    if (quiet !== undefined) clearTimeout(quiet);
    observer.disconnect();
    for (const event of inputEvents) window.removeEventListener(event, pause, true);
    document.removeEventListener('visibilitychange', schedule);
  };
}
