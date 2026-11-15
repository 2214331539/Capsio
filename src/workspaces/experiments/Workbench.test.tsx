import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { emptyWorkspace, type Project } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { ResearchBackend } from '../../platform/research';
import { gitApi, type GitSnapshot } from '../../platform/git';
import { ExperimentWorkspace } from './ExperimentWorkspace';
import { DiffView, SourceControl } from './SourceControl';
import { BranchWidget } from './Toolbar';
import { experimentCatalog } from './catalog';
import { codeContext, type useCodeWorkspace } from './code-context';
import { executionStore, experimentApi } from './runtime';
import { developmentApi, developmentStore, type TerminalInfo } from './development';

vi.mock('../../components/prompts', () => ({
  confirmAction: vi.fn(async () => true),
  requestText: vi.fn(async () => 'feature/x'),
}));
vi.mock('./TerminalPanel', () => ({
  TerminalPanel: ({ terminals }: { terminals: TerminalInfo[] }) => (
    <div aria-label="终端会话">{terminals.map((item) => item.name).join(',')}</div>
  ),
}));
vi.mock('../../editor/CodeEditor', () => ({
  CodeEditor: () => <textarea aria-label="代码编辑" />,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  executionStore.setState({ runs: [], error: '' });
  codeContext.setState({ roots: {}, experiments: {} });
});
const root = 'F:/fixture/a';
const project: Project = {
  id: 'p1',
  name: 'Test',
  question: '',
  space: 'personal',
  createdAt: '2026-10-01',
};
const snapshot: GitSnapshot = {
  root,
  repository: true,
  branch: 'main',
  head: 'abc123',
  busy: false,
  changes: [
    { path: 'src/train.py', status: ' M' },
    { path: 'notes.md', status: '??' },
  ],
  branches: [
    { name: 'main', current: true },
    { name: 'dev', current: false },
    { name: 'feature/new-loss', current: false },
  ],
  history: [{ sha: 'abc123', subject: 'baseline', author: 'Fixture', time: '2026-11-01' }],
  stashes: [],
  worktrees: [
    { root, branch: 'main', head: 'abc', busy: false, locked: false, missing: false, changes: 0 },
    {
      root: 'F:/fixture/new-loss',
      branch: 'feature/new-loss',
      head: 'abc',
      busy: false,
      locked: false,
      missing: false,
      changes: 0,
    },
  ],
};
async function setup() {
  const data = emptyWorkspace();
  data.projects = [{ ...project }];
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: async (workspace) => workspace,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  });
  await store.getState().load();
  const backend: ResearchBackend = {
    listFiles: async () => [{ path: 'train.py', name: 'train.py', kind: 'file', size: 20 }],
    readFile: vi.fn(async (_p, path) => ({ path, content: 'print(1)', version: 'v1' })),
    writeFile: vi.fn(async (_p, path, content) => ({ path, content, version: 'v2' })),
    gitStatus: async () => [],
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    askAI: async () => '',
    listModels: async () => [],
    testModel: async () => {},
  };
  const code = {
    root,
    snapshot,
    ready: true,
    loading: false,
    error: '',
    refresh: vi.fn(),
  } as ReturnType<typeof useCodeWorkspace>;
  return { store, backend, code };
}
function Harness(props: {
  store: Awaited<ReturnType<typeof setup>>['store'];
  backend: ResearchBackend;
}) {
  const [view, setView] = useState('files');
  const [path, setPath] = useState<string | null>(null);
  return (
    <ExperimentWorkspace
      project={project}
      store={props.store}
      backend={props.backend}
      executions={[]}
      runtimeError=""
      view={view}
      onView={setView}
      activePath={path}
      onOpen={setPath}
      onSelect={() => {}}
      onContext={() => {}}
      sidebarOpen
      onSidebarToggle={() => {}}
      width={220}
      resize={null}
    />
  );
}

it('commits every change when nothing is staged, as VS Code does', async () => {
  const { store, backend, code } = await setup();
  vi.spyOn(gitApi, 'available').mockReturnValue(true);
  const action = vi.spyOn(gitApi, 'action').mockResolvedValue('abc1234');
  const user = userEvent.setup();
  render(
    <SourceControl
      projectId="p1"
      backend={backend}
      store={store}
      code={code}
      onOpenFile={vi.fn()}
      onOpenDiff={vi.fn()}
      onGraph={vi.fn()}
    />,
  );
  const message = screen.getByRole('textbox', { name: '提交消息' }) as HTMLTextAreaElement;
  await user.type(message, 'Tune the loss');
  await user.click(screen.getByRole('button', { name: '提交所有更改' }));
  await waitFor(() => expect(action).toHaveBeenCalledTimes(3));
  expect(action.mock.calls.map(([, , request]) => request)).toEqual([
    { kind: 'stage', path: 'src/train.py' },
    { kind: 'stage', path: 'notes.md' },
    { kind: 'commit', message: 'Tune the loss' },
  ]);
  await waitFor(() => expect(message.value).toBe(''));
  expect(code.refresh).toHaveBeenCalled();
});

it('stages a file, opens its diff, and offers to discard only tracked changes', async () => {
  const { store, backend, code } = await setup();
  vi.spyOn(gitApi, 'available').mockReturnValue(true);
  const action = vi.spyOn(gitApi, 'action').mockResolvedValue('');
  vi.spyOn(gitApi, 'diff').mockResolvedValue('@@ -1 +1 @@\n-old\n+new\n');
  const onOpenDiff = vi.fn();
  const user = userEvent.setup();
  render(
    <SourceControl
      projectId="p1"
      backend={backend}
      store={store}
      code={code}
      onOpenFile={vi.fn()}
      onOpenDiff={onOpenDiff}
      onGraph={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: '放弃更改 notes.md' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '暂存 src/train.py' }));
  expect(action).toHaveBeenCalledWith('p1', root, { kind: 'stage', path: 'src/train.py' });
  await user.click(screen.getByRole('button', { name: '查看更改 notes.md' }));
  expect(onOpenDiff).toHaveBeenCalledWith('notes.md', false);
  await user.click(screen.getByRole('button', { name: '放弃更改 src/train.py' }));
  await waitFor(() =>
    expect(action).toHaveBeenLastCalledWith('p1', root, {
      kind: 'restore',
      path: 'src/train.py',
      expectedDiff: '@@ -1 +1 @@\n-old\n+new\n',
    }),
  );
  render(
    <DiffView projectId="p1" code={code} path="src/train.py" staged={false} onOpenFile={vi.fn()} />,
  );
  expect(await screen.findByRole('table', { name: '文件版本差异' })).toBeTruthy();
});

it('checks out a branch, or opens the folder where it is already checked out', async () => {
  const onCheckout = vi.fn();
  const onOpenRoot = vi.fn();
  const user = userEvent.setup();
  render(
    <BranchWidget
      snapshot={snapshot}
      readOnly={false}
      onInit={vi.fn()}
      onCheckout={onCheckout}
      onCreate={vi.fn()}
      onWorktree={vi.fn()}
      onGraph={vi.fn()}
      onOpenRoot={onOpenRoot}
    />,
  );
  await user.click(screen.getByRole('button', { name: '分支：main' }));
  await user.click(screen.getByRole('menuitemradio', { name: /feature\/new-loss/ }));
  expect(onOpenRoot).toHaveBeenCalledWith('F:/fixture/new-loss');
  await user.click(screen.getByRole('button', { name: '分支：main' }));
  await user.click(screen.getByRole('menuitemradio', { name: 'dev' }));
  expect(onCheckout).toHaveBeenCalledWith('dev');
  expect(onCheckout).toHaveBeenCalledTimes(1);
});

it('creates a branch and switches to it from the branch widget', async () => {
  const { store, backend } = await setup();
  vi.spyOn(gitApi, 'available').mockReturnValue(true);
  vi.spyOn(gitApi, 'inspect').mockResolvedValue(snapshot);
  const action = vi.spyOn(gitApi, 'action').mockResolvedValue('');
  const user = userEvent.setup();
  render(<Harness store={store} backend={backend} />);
  await user.click(await screen.findByRole('button', { name: '分支：main' }));
  await user.click(screen.getByRole('menuitem', { name: '创建新分支…' }));
  await waitFor(() =>
    expect(action.mock.calls.map(([, , request]) => request)).toEqual([
      { kind: 'branch-create', name: 'feature/x', revision: 'HEAD' },
      { kind: 'branch-switch', name: 'feature/x' },
    ]),
  );
  // Changes show in the explorer and on the Source Control icon.
  expect(screen.getByRole('tab', { name: '源代码管理' }).textContent).toBe('2');
});

it('clones a repository into a new folder and switches to it', async () => {
  const { store, backend } = await setup();
  vi.spyOn(experimentCatalog, 'available').mockReturnValue(true);
  const prepare = vi
    .spyOn(experimentCatalog, 'prepare')
    .mockResolvedValue({ id: 'e9', root: 'F:/clones/timing', source: 'existing' });
  const user = userEvent.setup();
  render(<Harness store={store} backend={backend} />);
  await user.click(await screen.findByRole('button', { name: /^代码文件夹/ }));
  await user.click(screen.getByRole('menuitem', { name: '克隆 Git 仓库…' }));
  await user.type(
    screen.getByRole('textbox', { name: '仓库地址' }),
    'https://github.com/org/timing.git',
  );
  await user.click(screen.getByRole('button', { name: '克隆' }));
  await waitFor(() =>
    expect(prepare).toHaveBeenCalledWith(
      'p1',
      'clone',
      undefined,
      'https://github.com/org/timing.git',
    ),
  );
  expect(await screen.findByRole('button', { name: '代码文件夹：timing' })).toBeTruthy();
  expect(store.getState().data?.experiments?.at(-1)).toMatchObject({
    id: 'e9',
    name: 'timing',
    root: 'F:/clones/timing',
  });
});

it('starts a terminal when the terminal tab opens with none running', async () => {
  const { store, backend } = await setup();
  vi.spyOn(experimentApi, 'available').mockReturnValue(true);
  vi.spyOn(developmentApi, 'trust').mockResolvedValue(true);
  const terminal = vi.spyOn(developmentApi, 'terminal').mockResolvedValue({
    id: 't1',
    project: 'p1',
    experimentId: 'p1',
    root,
    name: 'powershell',
    profile: 'powershell',
    environment: null,
    status: 'running',
  } as TerminalInfo);
  const user = userEvent.setup();
  render(<Harness store={store} backend={backend} />);
  await user.click(await screen.findByRole('tab', { name: '终端' }));
  await waitFor(() =>
    expect(terminal).toHaveBeenCalledWith('p1', expect.objectContaining({ action: 'open' })),
  );
  expect((await screen.findByLabelText('终端会话')).textContent).toBe('powershell');
  // Coming back to the tab with a terminal open does not start another.
  await user.click(screen.getByRole('tab', { name: '运行' }));
  await user.click(screen.getByRole('tab', { name: '终端' }));
  expect(terminal).toHaveBeenCalledTimes(1);
  developmentStore.setState({ terminals: [] });
});
