import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { InterpreterPicker } from './InterpreterPicker';
import { ExperimentWorkspace } from './ExperimentWorkspace';
import {
  developmentApi,
  developmentStore,
  type EnvironmentTask,
  type Interpreter,
} from './development';
import { emptyWorkspace, normalizeExperiments, type Project } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { ResearchBackend } from '../../platform/research';
import { confirmAction } from '../../components/prompts';
import { codeContext } from './code-context';

vi.mock('../../components/prompts', () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock('../../editor/CodeEditor', () => ({
  CodeEditor: () => <textarea aria-label="代码编辑" />,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  developmentStore.setState({ terminals: [], tasks: [] });
  codeContext.setState({ roots: {}, experiments: {} });
});
const project: Project = {
  id: 'p1',
  name: 'Paper',
  question: '',
  space: 'personal',
  createdAt: 'now',
};
const base: Interpreter = {
  executable: 'F:/Python/python.exe',
  prefix: 'F:/Python',
  version: '3.12.9',
  manager: 'system',
};
async function fixture(files: string[] = []) {
  const data = emptyWorkspace();
  data.projects.push({ ...project });
  normalizeExperiments(data);
  data.experiments!.push({
    ...data.experiments![0],
    id: 'e2',
    source: 'existing',
    root: 'F:/other',
    name: 'Other',
  });
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: 'F:/Data/workspace', legacyAvailable: false }),
    save: async (d) => d,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  });
  await store.getState().load();
  const backend = {
    listFiles: vi.fn(async () =>
      files.map((path) => ({ path, name: path, kind: 'file' as const, size: 1 })),
    ),
    readFile: vi.fn(async (_p: string, path: string) => ({ path, content: '', version: 'v1' })),
    writeFile: vi.fn(),
    gitStatus: async () => [],
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    askAI: async () => '',
    listModels: async () => [],
    testModel: async () => {},
  } as unknown as ResearchBackend;
  return { store, backend };
}
const task: EnvironmentTask = {
  id: 'prep',
  project: 'p1',
  experimentId: 'p1',
  root: 'F:/project',
  kind: 'venv',
  command: [],
  prefix: 'F:/project/.venv',
  status: 'running',
  exitCode: null,
  error: null,
  environment: null,
  startedAt: 1,
};

it('checks a found interpreter or a typed path before using it, for this folder only', async () => {
  const { store, backend } = await fixture();
  vi.spyOn(developmentApi, 'trust').mockResolvedValue(true);
  const api = vi.spyOn(developmentApi, 'python').mockImplementation(async (_p, _e, request) => {
    if ((request as { action: string }).action === 'inspect') return base;
    return { interpreters: [base], condaAvailable: false };
  });
  const onClose = vi.fn();
  const user = userEvent.setup();
  const props = {
    projectId: 'p1',
    store,
    backend,
    onStarted: vi.fn(),
    onClose,
  };
  const view = render(
    <InterpreterPicker {...props} experiment={store.getState().data!.experiments![0]} />,
  );
  await user.click(await screen.findByRole('button', { name: /Python 3\.12\.9/ }));
  await waitFor(() => expect(store.getState().data?.experiments?.[0].python).toEqual(base));
  expect(store.getState().data?.experiments?.[1].python).toBeUndefined();
  expect(onClose).toHaveBeenCalledTimes(1);
  view.unmount();
  render(<InterpreterPicker {...props} experiment={store.getState().data!.experiments![0]} />);
  await user.click(await screen.findByRole('button', { name: '输入解释器路径…' }));
  api.mockRejectedValue(new Error('Invalid interpreter'));
  await user.type(
    screen.getByRole('textbox', { name: '选择 Python 解释器' }),
    'F:/broken.exe{Enter}',
  );
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Invalid interpreter'),
  );
  expect(store.getState().data?.experiments?.[0].python).toEqual(base);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('asks for trust before looking for interpreters and closes when refused', async () => {
  const { store, backend } = await fixture();
  vi.spyOn(developmentApi, 'trust').mockResolvedValue(false);
  vi.mocked(confirmAction).mockResolvedValueOnce(false);
  const api = vi.spyOn(developmentApi, 'python');
  const onClose = vi.fn();
  render(
    <InterpreterPicker
      projectId="p1"
      experiment={store.getState().data!.experiments![0]}
      store={store}
      backend={backend}
      onStarted={vi.fn()}
      onClose={onClose}
    />,
  );
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api).not.toHaveBeenCalled();
});

it('installs what the folder declares once an interpreter is chosen', async () => {
  const { store, backend } = await fixture(['requirements.txt', 'train.py']);
  await store.getState().update((data) => {
    data.experiments![0].python = { ...base, manager: 'venv' };
  });
  vi.spyOn(developmentApi, 'trust').mockResolvedValue(true);
  const api = vi.spyOn(developmentApi, 'python').mockImplementation(async (_p, _e, request) => {
    if ((request as { action: string }).action === 'start')
      return { ...task, kind: 'requirements' };
    return { interpreters: [base], condaAvailable: false };
  });
  const user = userEvent.setup();
  render(
    <InterpreterPicker
      projectId="p1"
      experiment={store.getState().data!.experiments![0]}
      store={store}
      backend={backend}
      onStarted={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: /pip install -e/ })).toBeNull();
  await user.click(await screen.findByRole('button', { name: '安装 requirements.txt 中的依赖' }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('p1', 'p1', {
      action: 'start',
      kind: 'requirements',
      packages: [],
      target: 'requirements.txt',
    }),
  );
});

it('creates a venv from the status bar, shows it preparing and uses it when ready', async () => {
  const { store, backend } = await fixture();
  vi.spyOn(developmentApi, 'trust').mockResolvedValue(true);
  const api = vi.spyOn(developmentApi, 'python').mockImplementation(async (_p, _e, request) => {
    if ((request as { action: string }).action === 'start') return task;
    return { interpreters: [base], condaAvailable: false };
  });
  function Harness() {
    const [view, setView] = useState('files');
    const [path, setPath] = useState<string | null>(null);
    return (
      <ExperimentWorkspace
        project={project}
        store={store}
        backend={backend}
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
  const user = userEvent.setup();
  render(<Harness />);
  // Environments are no longer a side view; that slot is for extensions.
  await user.click(await screen.findByRole('tab', { name: '扩展' }));
  expect(screen.getAllByText('待开发').filter((item) => !item.closest('[hidden]'))).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Python 解释器：选择解释器' }));
  await user.click(await screen.findByRole('button', { name: '创建虚拟环境…' }));
  await user.click(await screen.findByRole('button', { name: /Python 3\.12\.9/ }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('p1', 'p1', {
      action: 'start',
      kind: 'venv',
      packages: [],
      base: base.executable,
      target: '.venv',
    }),
  );
  expect(await screen.findByRole('button', { name: /正在准备环境/ })).toBeTruthy();
  expect(store.getState().data?.experiments?.[0].python).toBeUndefined();
  const environment = {
    ...base,
    executable: 'F:/project/.venv/Scripts/python.exe',
    prefix: 'F:/project/.venv',
    manager: 'venv',
  };
  act(() => developmentStore.setState({ tasks: [{ ...task, status: 'completed', environment }] }));
  await waitFor(() => expect(store.getState().data?.experiments?.[0].python).toEqual(environment));
  expect(
    await screen.findByRole('button', { name: "Python 解释器：3.12.9 ('.venv')" }),
  ).toBeTruthy();
});
