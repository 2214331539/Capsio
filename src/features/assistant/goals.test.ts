import { afterEach, expect, it, vi } from 'vitest';
import { AgentRuntime } from './agent-runtime';
import { asConversation, newConversation } from './model';
import { assistantNotices, noticeAssistant, showConversation, watchAssistant } from './notices';
import { clearToasts } from '../../components/feedback';
import { createWorkspaceStore } from '../../stores/workspace';
import { emptyWorkspace, type Workspace } from '../../domain/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import type { AgentBackend, AgentEvent } from '../../platform/agent';

const connection = {
  endpoint: 'http://localhost/v1',
  model: 'test-model',
  provider: 'openai' as const,
};
const runtimes: AgentRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  assistantNotices.setState({ items: [], watching: null, shown: {} });
  clearToasts();
});

const goal = (status: string, tokensUsed = 1200) => ({
  threadId: 'thread',
  objective: '训练跑完后分析结果',
  status,
  tokenBudget: null,
  tokensUsed,
  timeUsedSeconds: 90,
  createdAt: 0,
  updatedAt: 0,
});
const note = (method: string, params: Record<string, unknown>): AgentEvent =>
  ({ kind: 'notification', method, params: { threadId: 'thread', ...params } }) as AgentEvent;
const answer = (turn: string, text: string) =>
  note('turn/completed', {
    turn: {
      id: turn,
      status: 'completed',
      items: [{ type: 'agentMessage', id: `a-${turn}`, text }],
    },
  });

async function harness() {
  const data = emptyWorkspace();
  data.projects.push({ id: 'p1', name: '蛋白质', question: '', space: 'personal', createdAt: '' });
  let disk = data;
  // A save waits here while a test holds it, to let the engine move on meanwhile.
  const gate: { hold: Promise<void> | null } = { hold: null };
  const store = createWorkspaceStore({
    load: async () => ({ workspace: disk, directory: 'test', legacyAvailable: false }),
    save: vi.fn(async (draft: Workspace) => {
      if (gate.hold) await gate.hold;
      return (disk = structuredClone(draft));
    }),
  } as unknown as WorkspaceBackend);
  await store.getState().load();
  const events: AgentEvent[] = [];
  const agent = {
    status: vi.fn(),
    handshake: vi.fn(),
    domains: vi.fn(),
    startThread: vi.fn(
      async (
        projectId: string,
        domain: string,
        _: unknown,
        options: { conversationId: string },
      ) => ({
        threadId: 'thread',
        conversationId: options.conversationId,
        projectId,
        domain,
        cwd: 'C:/p1/code',
      }),
    ),
    startTurn: vi.fn(async () => ({ turnId: 'turn-1', status: 'inProgress', events: [] })),
    events: vi.fn(async () => events.splice(0)),
    goal: vi.fn(async () => ({ goal: goal('paused') })),
    respond: vi.fn(),
    release: vi.fn(async () => {}),
  } as unknown as AgentBackend;
  const runtime = new AgentRuntime(store, agent);
  runtimes.push(runtime);
  return { store, agent, runtime, events, gate };
}
const chatOf = (store: Awaited<ReturnType<typeof harness>>['store']) =>
  asConversation(store.getState().data!.sessions[0]);

it('takes the turns an active goal starts on its own and reports when the goal is done', async () => {
  const { store, agent, runtime, events } = await harness();
  const chat = newConversation('p1');
  await runtime.send(chat, 'code', connection, '启动训练，跑完后分析结果');
  events.push(
    note('thread/goal/updated', { turnId: 'turn-1', goal: goal('active') }),
    answer('turn-1', '训练已启动，跑完后接着分析。'),
  );
  await runtime.poll();
  let saved = asConversation(store.getState().data!.sessions[0]);
  expect(saved.messages.at(-1)?.text).toBe('训练已启动，跑完后接着分析。');
  expect(saved.agentGoal?.status).toBe('active');
  // The idle conversation keeps listening and is not released while its goal is active.
  const task = runtime.get('p1', chat.id)!;
  task.lastActivity = Date.now() - 120_000;
  events.push(
    note('turn/started', { turn: { id: 'turn-2', status: 'inProgress' } }),
    note('thread/goal/updated', { turnId: 'turn-2', goal: goal('complete', 5400) }),
    answer('turn-2', '训练完成，验证集准确率 92%。'),
  );
  await runtime.poll();
  await runtime.poll();
  expect(agent.release).not.toHaveBeenCalled();
  saved = asConversation(store.getState().data!.sessions[0]);
  expect(saved.messages.at(-1)?.text).toBe('训练完成，验证集准确率 92%。');
  expect(saved.messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
  expect(saved.agentGoal?.status).toBe('complete');
  expect(assistantNotices.getState().items).toMatchObject([
    { projectId: 'p1', conversationId: chat.id, kind: 'complete' },
  ]);
});

it('pauses a goal through the engine and keeps its state in the conversation', async () => {
  const { agent, runtime, events } = await harness();
  const chat = newConversation('p1');
  await runtime.send(chat, 'code', connection, '持续优化');
  events.push(note('thread/goal/updated', { goal: goal('active') }), answer('turn-1', '开始'));
  await runtime.poll();
  const task = runtime.get('p1', chat.id)!;
  expect(await task.session.goal('set', { status: 'paused' })).toBe(true);
  expect(vi.mocked(agent.goal!).mock.calls[0][0]).toMatchObject({
    threadId: 'thread',
    action: 'set',
    status: 'paused',
  });
  expect(task.state.goal?.status).toBe('paused');
});

it('tells about a finished turn only when its project is out of sight', () => {
  watchAssistant('p1');
  noticeAssistant({ projectId: 'p1', conversationId: 'c1', title: '对话', kind: 'done' });
  expect(assistantNotices.getState().items).toHaveLength(0);
  watchAssistant('p2');
  noticeAssistant({ projectId: 'p1', conversationId: 'c1', title: '对话', kind: 'done' });
  expect(assistantNotices.getState().items).toHaveLength(1);
});

it('still tells about another conversation of the project that is on screen', () => {
  watchAssistant('p1');
  showConversation('p1', 'c1');
  noticeAssistant({ projectId: 'p1', conversationId: 'c1', title: '对话', kind: 'done' });
  expect(assistantNotices.getState().items).toHaveLength(0);
  noticeAssistant({ projectId: 'p1', conversationId: 'c2', title: '后台', kind: 'blocked' });
  expect(assistantNotices.getState().items).toMatchObject([{ conversationId: 'c2' }]);
  // Once the panel leaves its conversation, nothing is known to be on screen.
  showConversation('p1', null);
  expect(assistantNotices.getState().shown).toEqual({});
});

it('saves the answer of a turn that ends in the same batch as the next one begins', async () => {
  const { store, runtime, events } = await harness();
  const chat = newConversation('p1');
  await runtime.send(chat, 'code', connection, '分两轮做');
  events.push(
    note('thread/goal/updated', { goal: goal('active') }),
    answer('turn-1', '第一轮的回答'),
    note('turn/started', { turn: { id: 'turn-2', status: 'inProgress' } }),
  );
  await runtime.poll();
  await vi.waitFor(() => expect(chatOf(store).messages.at(-1)?.text).toBe('第一轮的回答'));
  expect(chatOf(store).agentStatus).toBe('completed');
  expect(runtime.get('p1', chat.id)?.state).toMatchObject({ turnId: 'turn-2', phase: 'running' });
});

it('saves the next turn of a goal even when it ends while the last one is still being saved', async () => {
  const { store, runtime, events, gate } = await harness();
  const chat = newConversation('p1');
  await runtime.send(chat, 'code', connection, '持续做');
  let release!: () => void;
  gate.hold = new Promise<void>((resolve) => (release = resolve));
  events.push(
    note('thread/goal/updated', { goal: goal('active') }),
    answer('turn-1', '第一轮的回答'),
  );
  await runtime.poll();
  const task = runtime.get('p1', chat.id)!;
  expect(task.saving).toBe(true);
  events.push(
    note('turn/started', { turn: { id: 'turn-2', status: 'inProgress' } }),
    answer('turn-2', '第二轮的回答'),
  );
  await runtime.poll();
  release();
  await vi.waitFor(() =>
    expect(chatOf(store).messages.filter((m) => m.role === 'assistant')).toHaveLength(2),
  );
  expect(chatOf(store).messages.at(-1)?.text).toBe('第二轮的回答');
  expect(task.finished).toBe(true);
});

const runRecord = {
  model: 'test-model',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:01:00.000Z',
  error: null,
  operations: [{ id: 'op', label: '改文件', status: 'completed', output: 'ok' }],
  diff: 'diff --git a/x b/x',
  files: [{ path: 'x', kind: 'update' as const }],
};
const savedGoal = (status: 'active' | 'paused') => ({
  objective: '训练跑完后分析结果',
  status,
  tokenBudget: null,
  tokensUsed: 10,
  timeUsedSeconds: 5,
});

it('reopening a conversation with an active goal keeps the run and the goal it saved', async () => {
  const { store, agent, runtime } = await harness();
  vi.mocked(agent.goal!).mockResolvedValue({ goal: goal('active') });
  const chat = {
    ...newConversation('p1'),
    agentDomain: 'code' as const,
    agentStatus: 'completed' as const,
    agentRun: runRecord,
    agentGoal: savedGoal('active'),
  };
  await store.getState().update((data) => {
    data.sessions.push(structuredClone(chat));
  });
  await runtime.resume(chat, connection);
  expect(chatOf(store)).toMatchObject({ agentRun: runRecord, agentStatus: 'completed' });
  expect(chatOf(store).agentGoal?.status).toBe('active');
});

it('keeps the saved goal when the engine cannot be reached on reopening', async () => {
  const { store, agent, runtime } = await harness();
  vi.mocked(agent.startThread).mockRejectedValueOnce(new Error('engine down'));
  const chat = {
    ...newConversation('p1'),
    agentDomain: 'code' as const,
    agentStatus: 'running' as const,
    agentGoal: savedGoal('active'),
  };
  await store.getState().update((data) => {
    data.sessions.push(structuredClone(chat));
  });
  await runtime.resume(chat, connection);
  expect(chatOf(store).agentStatus).toBe('failed');
  expect(chatOf(store).agentGoal?.status).toBe('active');
});

it('does not drop a paused goal by sending, and drops it when the engine clears it', async () => {
  const { store, runtime, events } = await harness();
  const chat = { ...newConversation('p1'), agentGoal: savedGoal('paused') };
  await runtime.send(chat, 'code', connection, '再问一件事');
  expect(chatOf(store).agentGoal?.status).toBe('paused');
  events.push(note('thread/goal/cleared', {}), answer('turn-1', '好的'));
  await runtime.poll();
  await vi.waitFor(() => expect(chatOf(store).messages.at(-1)?.text).toBe('好的'));
  expect(chatOf(store).agentGoal).toBeUndefined();
});
