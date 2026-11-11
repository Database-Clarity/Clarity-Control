/**
 * Cloudflare Turnstile for anonymous and role-less reports: rendered explicitly with the
 * `interaction-only` appearance (nothing shows unless a challenge is needed) and `execute` on
 * Send, since a token expires after 300 s and writing notes takes longer. There is never a
 * "passed" state: every send asks for a fresh, single-use token.
 */

/** Public by design. Localhost cannot use it, so it gets Cloudflare's documented always-pass test key. */
export const productionSitekey = '0x4AAAAAAF84gpfGEe32Kpjm';
export const testSitekey = '1x00000000000000000000AA';
export function turnstileSitekey(hostname = location.hostname): string {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname) ? testSitekey : productionSitekey;
}

interface TurnstileApi {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  execute(widget: string): void;
  reset(widget: string): void;
  remove(widget: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const scriptUrl = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let script: Promise<TurnstileApi> | undefined;
function loadTurnstile(): Promise<TurnstileApi> {
  script ??= new Promise<TurnstileApi>((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const element = document.createElement('script');
    element.src = scriptUrl;
    element.async = true;
    element.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile missing'));
    element.onerror = () => reject(new Error('Turnstile could not load'));
    document.head.append(element);
  }).catch((error: unknown) => {
    script = undefined;
    throw error;
  });
  return script;
}

export interface HumanCheck {
  /** Runs the check and resolves with a fresh token; rejects when it fails or times out. */
  token(): Promise<string>;
  /** Forget the current token (after any attempt): the next send runs a new check. */
  reset(): void;
  remove(): void;
}

/**
 * Mounts the widget in `container`. `onInteractive(true)` fires when Cloudflare needs the reporter
 * to interact (the row becomes visible), `false` once that is over.
 */
export async function mountHumanCheck(
  container: HTMLElement,
  onInteractive: (visible: boolean) => void,
  theme: 'light' | 'dark',
): Promise<HumanCheck> {
  const api = await loadTurnstile();
  let waiting: { resolve(token: string): void; reject(error: Error): void } | undefined;
  const settle = (outcome: string | Error) => {
    const current = waiting;
    waiting = undefined;
    if (!current) return;
    if (typeof outcome === 'string') current.resolve(outcome);
    else current.reject(outcome);
  };
  const widget = api.render(container, {
    sitekey: turnstileSitekey(),
    action: 'report',
    appearance: 'interaction-only',
    execution: 'execute',
    theme,
    'refresh-expired': 'manual',
    callback: (token: string) => settle(token),
    'error-callback': () => {
      settle(new Error('failed'));
      return true;
    },
    'expired-callback': () => settle(new Error('expired')),
    'timeout-callback': () => settle(new Error('timeout')),
    'before-interactive-callback': () => onInteractive(true),
    'after-interactive-callback': () => onInteractive(false),
  });
  return {
    token() {
      settle(new Error('superseded'));
      return new Promise<string>((resolve, reject) => {
        waiting = { resolve, reject };
        try {
          api.reset(widget);
          api.execute(widget);
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    reset() {
      settle(new Error('reset'));
      try {
        api.reset(widget);
      } catch {
        // The widget was removed with its container.
      }
      onInteractive(false);
    },
    remove() {
      settle(new Error('removed'));
      api.remove(widget);
    },
  };
}
