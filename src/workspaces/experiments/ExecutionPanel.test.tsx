import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionPanel } from './ExecutionPanel';
import { experimentApi, type Execution } from './runtime';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('lets go of the end of the log when scrolled up and offers the way back', async () => {
  vi.spyOn(experimentApi, 'log').mockResolvedValue('line 1\nline 2');
  const run = {
    id: 'run-12345678',
    status: 'completed',
    name: 'train',
    executable: 'python',
    configuration: { args: [] },
  } as unknown as Execution;
  const user = userEvent.setup();
  render(<ExecutionPanel run={run} />);
  const log = await screen.findByLabelText('只读运行日志');
  Object.defineProperties(log, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 200, configurable: true },
  });
  expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();
  log.scrollTop = 100;
  fireEvent.scroll(log);
  await user.click(await screen.findByRole('button', { name: '回到最新' }));
  expect(log.scrollTop).toBe(1000);
  expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();
});
