import { t } from '../i18n';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { emptyWorkspace, type Project } from '../domain/workspace';
import type { FileContent, ResearchBackend } from '../platform/research';
import type { WorkspaceBackend } from '../platform/desktop';
import { createWorkspaceStore } from '../stores/workspace';
import { getFileSession, type FileSession } from '../editor/sessions';
import { App } from './App';
import { codeContext } from '../workspaces/experiments/code-context';
import { getAgentRuntime } from '../features/assistant/agent-runtime';
import { newConversation } from '../features/assistant/model';
import type { AgentBackend, AgentEvent } from '../platform/agent';

const nativeWindow = vi.hoisted(() => ({
  close: undefined as undefined | ((event: { preventDefault(): void }) => Promise<void>),
  destroy: vi.fn(),
  hide: vi.fn(async () => {}),
  root: 'F:/old',
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(async (command: string) => {
    if (command === 'experiment_list') return [];
    if (command === 'research_git_diff') return '@@ -1 +1 @@\n-old\n+new\n';
    if (command === 'code_git_diff') return '@@ -1 +1 @@\n-old\n+new\n';
    if (command === 'code_git_inspect')
      return {
        root: nativeWindow.root,
        repository: true,
        branch: 'main',
        head: '123456',
        changes: [{ path: 'paper.md', status: ' M' }],
        branches: [],
        history: [],
        stashes: [],
        worktrees: [],
        busy: false,
      };
    return undefined;
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => nativeWindow.close?.({ preventDefault() {} }),
    onCloseRequested: async (listener: typeof nativeWindow.close) => {
      nativeWindow.close = listener;
      return () => {
        nativeWindow.close = undefined;
      };
    },
    destroy: nativeWindow.destroy,
    hide: nativeWindow.hide,
    show: async () => {},
  }),
}));
vi.mock('../editor/CodeEditor', () => ({
  CodeEditor: ({ session }: { session: FileSession }) => {
    const data = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return (
      <textarea
        aria-label={`编辑 ${session.path}`}
        value={data.content}
        onChange={(event) => session.edit(event.target.value)}
      />
    );
  },
}));
beforeAll(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  codeContext.setState({ roots: {} });
  nativeWindow.destroy.mockClear();
});

function setup() {
  const data = emptyWorkspace();
  const project: Project = {
    id: 'p1',
    name: 'Directory test',
    question: '',
    path: 'F:/old',
    space: 'personal',
    createdAt: '2026-09-23',
  };
  data.projects.push(project);
  let root = project.path;
  nativeWindow.root = root ?? '';
  const workspace: WorkspaceBackend = {
    load: async () => ({ workspace: data, directory: 'data', legacyAvailable: false }),
    save: vi.fn(async (value) => {
      root = value.projects[0]?.path;
      nativeWindow.root = root ?? '';
      return value;
    }),
    restore: vi.fn(async () => data),
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => 'F:/new',
  };
  const backend: ResearchBackend = {
    listFiles: vi.fn(async () => [
      { path: 'paper.md', name: 'paper.md', kind: 'file' as const, size: 12 },
    ]),
    readFile: vi.fn(async (_project, path) => ({
      path,
      content: root === 'F:/old' ? '# Old root' : '# New root',
      version: 'v1',
    })),
    writeFile: vi.fn(async (_project, path, content) => ({ path, content, version: 'v2' })),
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    gitStatus: async () => [],
    listModels: async () => [],
    testModel: async () => {},
    askAI: async () => '',
  };
  localStorage.setItem(
    'scientify.ui.v1',
    JSON.stringify({
      version: 1,
      projectId: 'p1',
      locations: {
        p1: {
          workspace: 'experiments',
          view: 'files',
          paths: { experiments: 'paper.md' },
          paperId: null,
        },
      },
    }),
  );
  return { store: createWorkspaceStore(workspace), backend, workspace };
}

const moduleButton = (name: string) =>
  within(screen.getByRole('navigation', { name: '一级导航' })).getByRole('button', { name });

it('remembers the code view after opening a changed file and leaving the workspace', async () => {
  const { store, backend } = setup();
  backend.gitStatus = vi.fn(async () => [{ path: 'paper.md', status: 'M' }]);
  const user = userEvent.setup();
  await act(async () => {
    render(<App store={store} backend={backend} />);
  });
  await screen.findByLabelText('编辑 paper.md');
  await user.click(moduleButton(t('Experiments')));
  await user.click(screen.getByRole('tab', { name: '源代码管理' }));
  await user.click(await screen.findByLabelText('查看更改 paper.md'));
  // The diff opens as an editor tab; its button opens the file in another tab.
  expect(screen.getByRole('tab', { name: 'paper.md (工作树)' }).getAttribute('aria-selected')).toBe(
    'true',
  );
  await user.click(within(screen.getByRole('main')).getByLabelText('打开文件'));
  expect(screen.getByRole('tab', { name: 'paper.md' }).getAttribute('aria-selected')).toBe('true');
  await user.click(moduleButton(t('文档')));
  await user.click(moduleButton(t('Experiments')));
  expect(screen.getByRole('tab', { name: 'paper.md' }).getAttribute('aria-selected')).toBe('true');
  expect(
    await within(screen.getByRole('main')).findByRole('textbox', { name: '编辑 paper.md' }),
  ).toBeTruthy();
});

it('waits for a pending file save before closing and blocks workspace replacement meanwhile', async () => {
  const { store, backend, workspace } = setup();
  await act(async () => {
    render(<App store={store} backend={backend} />);
  });
  await screen.findByLabelText('编辑 paper.md');
  const session = getFileSession(backend, 'p1', 'paper.md', 'F:/old');
  let complete!: (file: FileContent) => void;
  backend.writeFile = vi.fn(
    () =>
      new Promise<FileContent>((resolve) => {
        complete = resolve;
      }),
  );
  let saving!: Promise<boolean>;
  await act(async () => {
    session.edit('submitted');
    saving = session.save();
    session.edit('# Old root');
  });
  expect(session.getSnapshot().dirty).toBe(false);
  expect(store.getState().dirtySources.files).toBe(true);
  await act(async () => {
    expect(await store.getState().replace('restore')).toBe(false);
  });
  expect(workspace.restore).not.toHaveBeenCalled();
  const event = { preventDefault: vi.fn() };
  const closing = nativeWindow.close?.(event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(nativeWindow.destroy).not.toHaveBeenCalled();
  await act(async () => {
    complete({ path: 'paper.md', content: 'submitted', version: 'v2' });
    await saving;
  });
  // The save landed; the edit made after it is still unsaved, so closing asks first.
  const prompt = await screen.findByRole('dialog', { name: '确认操作' });
  await userEvent.setup().click(within(prompt).getByRole('button', { name: '取消' }));
  await act(async () => {
    await closing;
  });
  expect(nativeWindow.destroy).not.toHaveBeenCalled();
});

it('closing stops a running AI turn, saves it as interrupted and then closes', async () => {
  const { store, backend } = setup();
  await act(async () => {
    render(<App store={store} backend={backend} />);
  });
  await screen.findByLabelText('编辑 paper.md');
  const events: AgentEvent[] = [];
  const agent = {
    startThread: async () => ({ threadId: 'thread', cwd: 'F:/old' }),
    startTurn: async () => ({ turnId: 'turn', status: 'inProgress', events: [] }),
    events: async () => events.splice(0),
    interrupt: async () => {
      events.push({
        kind: 'notification',
        method: 'turn/completed',
        params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } },
      });
    },
  } as unknown as AgentBackend;
  const runtime = getAgentRuntime(store, agent);
  const chat = newConversation('p1');
  try {
    await act(async () => {
      await runtime.send(
        chat,
        'code',
        { endpoint: 'http://localhost/v1', model: 'test', provider: 'openai' },
        '运行实验',
      );
    });
    expect(Object.keys(store.getState().agentTasks)).toHaveLength(1);
    await act(async () => {
      await nativeWindow.close?.({ preventDefault() {} });
    });
    expect(nativeWindow.destroy).toHaveBeenCalledOnce();
    expect(store.getState().agentTasks).toEqual({});
    expect(store.getState().data!.sessions.find((s) => s.id === chat.id)?.agentStatus).toBe(
      'interrupted',
    );
  } finally {
    runtime.dispose();
  }
});

it('blocks directory changes with drafts and reloads the tree and editor after a clean rebind', async () => {
  const { store, backend } = setup();
  const user = userEvent.setup();
  await act(async () => {
    render(<App store={store} backend={backend} />);
  });
  await screen.findByLabelText('编辑 paper.md');
  const original = getFileSession(backend, 'p1', 'paper.md', 'F:/old');
  await act(async () => {
    original.edit('dirty buffer');
  });
  await user.click(screen.getByLabelText('切换项目'));
  await user.click(
    within(screen.getByRole('menu', { name: '项目切换' })).getByRole('menuitem', {
      name: '项目设置',
    }),
  );
  let settings = within(screen.getByRole('dialog'));
  expect((settings.getByRole('button', { name: '选择目录' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await user.click(screen.getByLabelText('关闭弹窗'));
  await act(async () => {
    original.edit('# Old root');
  });
  const previousListings = vi.mocked(backend.listFiles).mock.calls.length;
  await user.click(screen.getByLabelText('切换项目'));
  await user.click(
    within(screen.getByRole('menu', { name: '项目切换' })).getByRole('menuitem', {
      name: '项目设置',
    }),
  );
  settings = within(screen.getByRole('dialog'));
  await user.click(settings.getByRole('button', { name: '选择目录' }));
  await user.click(settings.getByRole('button', { name: '保存项目' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(codeContext.getState().roots.p1).toBe('F:/new'));
  await user.click(await screen.findByRole('treeitem', { name: 'paper.md' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: '编辑 paper.md' }) as HTMLTextAreaElement).value,
    ).toBe('# New root'),
  );
  expect(getFileSession(backend, 'p1', 'paper.md', 'F:/new')).not.toBe(original);
  expect(vi.mocked(backend.listFiles).mock.calls.length).toBeGreaterThan(previousListings);
});

it('opens the exact experiment source, remembers selection, and opens a recent note directly', async () => {
  const { store, backend } = setup();
  const user = userEvent.setup();
  await act(async () => {
    render(<App store={store} backend={backend} />);
  });
  await screen.findByLabelText('编辑 paper.md');
  await act(async () => {
    await store.getState().update((draft) => {
      draft.runs.push(
        {
          id: 'r-old',
          project: 'p1',
          name: 'Ablation result',
          protocol: '',
          config: '',
          conclusion: 'Older experiment',
          status: 'completed',
          updatedAt: '2026-09-20',
          metrics: [],
        },
        {
          id: 'r-new',
          project: 'p1',
          name: 'Latest result',
          protocol: '',
          config: '',
          conclusion: 'Latest experiment',
          status: 'completed',
          updatedAt: '2026-09-23',
          metrics: [],
        },
      );
      draft.records.push({
        id: 'n1',
        project: 'p1',
        title: 'Insight note',
        body: 'Keep the useful conclusion.',
        type: 'note',
        status: 'draft',
        createdAt: '2026-09-23',
        updatedAt: '2026-09-23',
      });
    });
  });
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('scientify-open-source', {
        detail: {
          projectId: 'p1',
          workspace: 'experiments',
          resourceId: 'r-old',
          title: 'Ablation result',
        },
      }),
    );
  });
  expect(await screen.findByRole('heading', { name: 'Ablation result' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: '运行记录' }).getAttribute('aria-selected')).toBe('true');
  expect(JSON.parse(localStorage.getItem('scientify.ui.v2')!).locations.p1.runId).toBe('r-old');
  await user.click(screen.getByRole('button', { name: /Latest result/ }));
  expect(JSON.parse(localStorage.getItem('scientify.ui.v2')!).locations.p1.runId).toBe('r-new');
  // Notes became documents; the documents module opens in their place.
  await user.click(moduleButton(t('文档')));
  expect(await screen.findByRole('heading', { name: '文档' })).toBeTruthy();
  await user.click(moduleButton(t('Experiments')));
  expect(await screen.findByRole('heading', { name: 'Latest result' })).toBeTruthy();
});

it('hides to the tray instead of quitting while a background goal is active', async () => {
  const { store, backend } = setup();
  await act(async () => {
    render(<App store={store} backend={backend} />);
  });
  await screen.findByLabelText('编辑 paper.md');
  const events: AgentEvent[] = [];
  const agent = {
    startThread: async () => ({ threadId: 'thread', cwd: 'F:/old' }),
    startTurn: async () => ({ turnId: 'turn', status: 'inProgress', events: [] }),
    events: async () => events.splice(0),
  } as unknown as AgentBackend;
  const runtime = getAgentRuntime(store, agent);
  const chat = newConversation('p1');
  try {
    await act(async () => {
      await runtime.send(
        chat,
        'code',
        { endpoint: 'http://localhost/v1', model: 'test', provider: 'openai' },
        '训练跑完后分析',
      );
    });
    events.push(
      {
        kind: 'notification',
        method: 'thread/goal/updated',
        params: {
          threadId: 'thread',
          goal: {
            objective: '分析',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
          },
        },
      } as AgentEvent,
      {
        kind: 'notification',
        method: 'turn/completed',
        params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } },
      } as AgentEvent,
    );
    await act(async () => {
      await runtime.poll();
    });
    nativeWindow.hide.mockClear();
    nativeWindow.destroy.mockClear();
    await act(async () => {
      await nativeWindow.close?.({ preventDefault() {} });
    });
    expect(nativeWindow.hide).toHaveBeenCalledOnce();
    expect(nativeWindow.destroy).not.toHaveBeenCalled();
  } finally {
    runtime.dispose();
  }
});
