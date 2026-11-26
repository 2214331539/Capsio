import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NativeTranslationPanel } from './NativeTranslationPanel';

const native = vi.hoisted(() => ({ invoke: vi.fn(), stop: vi.fn(), mac: false }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => native.stop) }));
vi.mock('../../platform/os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/os')>()),
  isMacOS: () => native.mac,
}));
beforeEach(() => {
  native.invoke.mockImplementation(async (_command, { action }) => ({
    enabled: action.type !== 'enabled' || action.enabled,
    running: true,
    hotkeyRunning: true,
    settingsError: null,
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  native.mac = false;
});

it('tells Mac users where to allow selection capture, with the Mac shortcut', async () => {
  native.mac = true;
  native.invoke.mockResolvedValue({
    enabled: true,
    running: false,
    hotkeyRunning: true,
    settingsError: null,
  });
  render(<NativeTranslationPanel />);
  const notice = await screen.findByRole('status');
  expect(notice.textContent).toContain('辅助功能');
  expect(notice.textContent).toContain('输入监控');
  expect(screen.getByText('⌘⇧T 翻译剪贴板中的文字。')).toBeTruthy();
});

it('opens the original settings and controls the same native engine without a second translator', async () => {
  render(<NativeTranslationPanel />);
  await screen.findByText('自动划词已启用');
  expect(screen.queryByRole('textbox')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '暂停划词' }));
  await screen.findByText('自动划词已暂停');
  await userEvent.click(screen.getByRole('button', { name: '打开完整翻译设置' }));
  expect(native.invoke).toHaveBeenCalledWith('translation_service', {
    action: { type: 'settings' },
  });
});

it('shows startup failures and can restart the service', async () => {
  native.invoke.mockRejectedValueOnce(new Error('fixture startup failure'));
  const view = render(<NativeTranslationPanel />);
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  view.unmount();
  await waitFor(() => expect(native.stop).toHaveBeenCalledOnce());
});
