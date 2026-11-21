import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { agentMood } from './AssistantTranscript';
import { initialAgentSession, type AgentSessionSnapshot } from './agent-session';
import { TurnProcess } from './TurnDetails';

afterEach(cleanup);

const state = (patch: Partial<AgentSessionSnapshot>): AgentSessionSnapshot => ({
  ...initialAgentSession,
  ...patch,
});

it('gives the mascot the face of what the turn is really doing', () => {
  const approval = { kind: 'request', id: 1, method: 'item/commandExecution/requestApproval' };
  const working = { id: 'a', label: '运行命令', status: 'inProgress', output: '' };
  expect(agentMood(state({ phase: 'waiting', approvals: [approval as never] }), true)).toBe(
    'waiting',
  );
  expect(agentMood(state({ phase: 'running', operations: [working] }), true)).toBe('working');
  expect(agentMood(state({ phase: 'running', thinkingSince: 1, thoughtMs: null }), true)).toBe(
    'thinking',
  );
  expect(agentMood(state({ outcome: 'completed' }), false)).toBe('done');
  expect(agentMood(state({ outcome: 'failed' }), false)).toBe('error');
  expect(agentMood(state({ outcome: 'interrupted' }), false)).toBeUndefined();
  expect(agentMood(state({}), false)).toBeUndefined();
});

it('opens a turn and each step with output by folding, keeping the content in place', async () => {
  const user = userEvent.setup();
  const { container } = render(
    <TurnProcess
      running={false}
      startedAt="2026-11-21T10:00:00Z"
      completedAt="2026-11-21T10:00:30Z"
      plan={[]}
      operations={[{ id: 'a', label: '运行 ls', status: 'completed', output: 'file-one' }]}
    />,
  );
  const turn = screen.getByRole('button', { name: /已处理 30 秒/ });
  expect(turn.getAttribute('aria-expanded')).toBe('false');
  // The body stays mounted while folded; it is only hidden from the page and from assistive tech.
  expect(container.querySelector('.sf-collapse[data-open="false"]')).not.toBeNull();
  await user.click(turn);
  expect(turn.getAttribute('aria-expanded')).toBe('true');
  const step = screen.getByRole('button', { name: '运行 ls' });
  expect(step.getAttribute('aria-expanded')).toBe('false');
  await user.click(step);
  expect(step.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('file-one')).toBeTruthy();
});

it('shows the waiting and failed turns with their own face even when they have no steps', () => {
  const { container, rerender } = render(
    <TurnProcess running mood="waiting" status="等待审批" plan={[]} operations={[]} />,
  );
  expect(screen.getByRole('button', { name: /等待审批/ })).toBeTruthy();
  expect(container.querySelector('.sf-mascot.is-waiting')).not.toBeNull();
  rerender(<TurnProcess running={false} mood="error" plan={[]} operations={[]} />);
  expect(screen.getByRole('button', { name: /处理出错/ })).toBeTruthy();
  expect(container.querySelector('.sf-mascot.is-error')).not.toBeNull();
  rerender(<TurnProcess running={false} mood="done" plan={[]} operations={[]} />);
  expect(container.textContent).toBe('');
});
