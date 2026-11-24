import { afterEach, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => invoke(...args),
}));

afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
});

it('opens dialogs and keeps the queue moving when the native side never answers', async () => {
  vi.useFakeTimers();
  const { browserLayout, hideBrowsers } = await import('./browser-pane');
  invoke.mockImplementation((name: string) =>
    name === 'browser_command' ? new Promise(() => {}) : Promise.resolve(),
  );
  let shown = false;
  void hideBrowsers().then(() => (shown = true));
  await vi.advanceTimersByTimeAsync(399);
  expect(shown).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(shown).toBe(true);
  // The stuck hide also gets reported.
  expect(invoke).toHaveBeenCalledWith('collaboration_report_error', expect.anything());

  invoke.mockImplementation(() => Promise.resolve(null));
  let ran = false;
  void browserLayout({ op: 'hideAll' }).then(() => (ran = true));
  await vi.advanceTimersByTimeAsync(1500);
  expect(ran).toBe(true);
});
