import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import { localCommand } from './library';
import { reportError } from './error-reports';
export type BrowserTab = {
  id: string;
  projectId: string;
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  httpStatus?: number | null;
  error: string | null;
  background?: boolean;
};

/**
 * The first page of every embedded browser tab: the home page of the search
 * engine chosen in Settings (browser.rs `HOME_ADDRESS`).
 */
export const DEFAULT_BROWSER_URL = 'capsio:home';
/** The search engines the address bar can use; `settings.browserSearch`. */
export const SEARCH_ENGINES = [
  ['google', 'Google'],
  ['bing', '必应'],
  ['baidu', '百度'],
] as const;

export const browserCommand = <T = void>(request: Record<string, unknown>) =>
  localCommand<T>('browser_command', { request });
export const browserEvents = (event: string, callback: (tab: BrowserTab) => void) =>
  isTauri() ? listen<BrowserTab>(event, (e) => callback(e.payload)) : Promise.resolve(() => {});

export async function openBrowserSource(projectId: string, address: string) {
  const tab = await browserCommand<BrowserTab>({ op: 'openUrl', project_id: projectId, address });
  window.dispatchEvent(
    new CustomEvent('capsio-open-browser', { detail: { projectId, tabId: tab.id } }),
  );
}

// All native layout commands use a single queue so a late show never overrides hide. A command
// the native side never answers must not hold the queue: every dialog waits on a hide.
const STUCK_MS = 1500;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let tail = Promise.resolve();
export function browserLayout(request: Record<string, unknown>) {
  const next = tail.then(() => browserCommand(request));
  tail = Promise.race([next, delay(STUCK_MS)]).then(
    () => {},
    () => {},
  );
  return next;
}

/** Hides the embedded browser before something draws over it, waiting at most `wait` ms so a
 *  dialog still opens when the native side does not answer; that case is reported. */
export function hideBrowsers(wait = 400): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  let done = false;
  const hidden = browserLayout({ op: 'hideAll' }).then(
    () => void (done = true),
    () => void (done = true),
  );
  return Promise.race([
    hidden,
    delay(wait).then(() => {
      if (!done)
        reportError(new Error(`The embedded browser did not hide within ${wait} ms`), 'browser');
    }),
  ]);
}
