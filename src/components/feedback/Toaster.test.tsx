import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearToasts, dismissToast, toast, toastError, toastUndo } from './Toaster';

afterEach(() => act(() => clearToasts()));

it('takes an action back from the toast and then goes away', async () => {
  const user = userEvent.setup();
  const undo = vi.fn();
  act(() => void toastUndo('Moved to trash', undo));
  expect((await screen.findByRole('status')).textContent).toContain('Moved to trash');
  await user.click(screen.getByRole('button', { name: '撤销' }));
  expect(undo).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});

it('keeps errors until closed and offers a retry', async () => {
  const user = userEvent.setup();
  const retry = vi.fn();
  act(() => void toastError('Upload failed', retry));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Upload failed');
  await user.click(screen.getByRole('button', { name: '重试' }));
  expect(retry).toHaveBeenCalledTimes(1);
});

it('dismisses by id', async () => {
  let id = 0;
  act(() => void (id = toast('Saved')));
  await screen.findByRole('status');
  act(() => dismissToast(id));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});
