import { afterEach, expect, it, vi } from 'vitest';
import { AgentRuntime } from './agent-runtime';
import { asConversation, newConversation } from './model';
import { assistantNotices, noticeAssistant, watchAssistant } from './notices';
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
  assistantNotices.setState({ items: [], watching: null });
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
  const store = createWorkspaceStore({
    load: async () => ({ workspace: disk, directory: 'test', legacyAvailable: false }),
    save: vi.fn(async (draft: Workspace) => (disk = structuredClone(draft))),
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
  return { store, agent, runtime, events };
}

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
