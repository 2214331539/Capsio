import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyWorkspace, normalizeExperiments } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import { ExperimentManager } from './ExperimentManager';
import { experimentCatalog, sameCodeRoot } from './catalog';
import { codeContext, selectExperiment } from './code-context';
import { ConfigurationForm } from './ExperimentWorkspace';
import { developmentStore } from './development';
import { clearToasts } from '../../components/feedback';
vi.mock('../../components/prompts', () => ({
  confirmAction: vi.fn(async () => true),
  requestText: vi.fn(async () => 'Renamed'),
}));
afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  codeContext.setState({ roots: {}, experiments: {} });
  developmentStore.setState({ terminals: [], tasks: [] });
  localStorage.removeItem('capsio.experiments.layout.v1');
});
async function setup() {
  const data = normalizeExperiments(emptyWorkspace());
  const project = {
    id: 'p1',
    name: 'Research',
    question: '',
    space: 'personal',
    createdAt: '2026-10-02',
  };
  data.projects.push(project);
  const store = createWorkspaceStore({
    load: async () => ({ workspace: data, directory: '', legacyAvailable: false }),
    save: async (d) => d,
    restore: async () => data,
    migrateLegacy: async () => data,
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => 'F:/fixture/ablation',
  });
  await store.getState().load();
  return { store, project };
}
it('migrates once, keeps removed experiments removed and accepts maximum-length legacy ids', () => {
  const data = emptyWorkspace();
  data.projects.push({
    id: 'x'.repeat(80),
    name: 'Old',
    question: '',
    space: 'personal',
    createdAt: 'now',
    path: 'F:/old',
    runConfigurations: [{ id: 'c1' }],
  });
  normalizeExperiments(data);
  expect(data.experiments?.[0].id).toHaveLength(80);
  expect(data.experiments?.[0].runConfigurations).toEqual([{ id: 'c1' }]);
  normalizeExperiments(data);
  expect(data.experiments).toHaveLength(1);
  data.experiments = [];
  normalizeExperiments(data);
  expect(data.experiments).toEqual([]);
});
it('registers a new isolated root and retains it when renaming, archiving and removing metadata', async () => {
  const { store, project } = await setup();
  vi.spyOn(experimentCatalog, 'available').mockReturnValue(true);
  vi.spyOn(experimentCatalog, 'prepare').mockResolvedValue({
    id: 'e2',
    root: 'F:/fixture/ablation',
    source: 'existing',
  });
  const opened = vi.fn();
  const user = userEvent.setup();
  render(<ExperimentManager project={project} store={store} executions={[]} onOpen={opened} />);
  await user.click(screen.getByRole('button', { name: '添加文件夹' }));
  await user.type(screen.getByLabelText('名称'), 'Ablation');
  await user.selectOptions(screen.getByLabelText('来源'), 'existing');
  await user.click(screen.getByRole('button', { name: '选择目录' }));
  await user.click(screen.getByRole('button', { name: '添加' }));
  await waitFor(() =>
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e2', root: 'F:/fixture/ablation' }),
    ),
  );
  await user.click(screen.getAllByRole('button', { name: '重命名文件夹' })[1]);
  const field = screen.getByRole('textbox', { name: '重命名文件夹' });
  await user.clear(field);
  await user.type(field, 'Renamed{Enter}');
  await waitFor(() => expect(store.getState().data?.experiments?.[1].name).toBe('Renamed'));
  await user.click(screen.getAllByRole('button', { name: '归档文件夹' })[1]);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Renamed' })).toBeNull());
  await user.click(screen.getByRole('button', { name: '已归档' }));
  expect((screen.getByRole('button', { name: 'Renamed' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await user.click(screen.getByRole('button', { name: '恢复文件夹' }));
  await waitFor(() => expect(store.getState().data?.experiments?.[1].archived).toBe(false));
  await user.click(screen.getAllByRole('button', { name: '从项目中移除' })[1]);
  await waitFor(() => expect(store.getState().data?.experiments).toHaveLength(1));
});
it('archives and removes at once and takes both back from the toast', async () => {
  const { store, project } = await setup();
  await store.getState().update((data) => {
    data.experiments!.push({
      ...data.experiments![0],
      id: 'e2',
      name: 'Ablation',
      root: 'F:/ablation',
      source: 'existing',
    });
  });
  const user = userEvent.setup();
  render(<ExperimentManager project={project} store={store} executions={[]} onOpen={() => {}} />);
  await user.click(screen.getAllByRole('button', { name: '归档文件夹' })[1]);
  await waitFor(() => expect(store.getState().data?.experiments?.[1].archived).toBe(true));
  await user.click(await screen.findByRole('button', { name: '撤销' }));
  await waitFor(() => expect(store.getState().data?.experiments?.[1].archived).toBe(false));
  clearToasts();
  await user.click(screen.getAllByRole('button', { name: '从项目中移除' })[1]);
  await waitFor(() => expect(store.getState().data?.experiments).toHaveLength(1));
  await user.click(await screen.findByRole('button', { name: '撤销' }));
  await waitFor(() => expect(store.getState().data?.experiments).toHaveLength(2));
  expect(store.getState().data?.experiments?.[1].id).toBe('e2');
});
it('saves configurations to the selected experiment and preserves the sibling configuration', async () => {
  const { store, project } = await setup();
  await store.getState().update((data) => {
    data.experiments!.push({
      ...data.experiments![0],
      id: 'e2',
      name: 'Ablation',
      root: 'F:/ablation',
      source: 'existing',
      runConfigurations: [],
    });
  });
  const user = userEvent.setup();
  render(
    <ConfigurationForm
      project={project}
      experimentId="e2"
      store={store}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
  await user.type(screen.getByLabelText('配置名称'), 'Train');
  await user.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() =>
    expect(store.getState().data?.experiments?.[1].runConfigurations).toEqual([
      expect.objectContaining({ name: 'Train' }),
    ]),
  );
  expect(store.getState().data?.experiments?.[0].runConfigurations).toEqual([]);
  act(() => selectExperiment('p1', store.getState().data!.experiments![1]));
  expect(codeContext.getState().roots.p1).toBe('F:/ablation');
  expect(sameCodeRoot('\\\\?\\F:\\ablation', 'f:/ablation')).toBe(true);
});
it('prevents removing an experiment with a running chat while other experiments stay editable', async () => {
  const { store, project } = await setup();
  await store.getState().update((data) => {
    data.sessions.push({ id: 'chat', project: 'p1', experimentId: 'p1' });
  });
  store.getState().setAgentTask('p1:chat', 'p1');
  render(<ExperimentManager project={project} store={store} executions={[]} onOpen={() => {}} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '从项目中移除' }));
  expect(screen.getByRole('alert').textContent).toContain('请先停止');
  expect(store.getState().data?.experiments).toHaveLength(1);
});
it('lists experiments in one table with their latest run', async () => {
  const { store, project } = await setup();
  const experiment = store.getState().data!.experiments![0];
  render(
    <ExperimentManager
      project={project}
      store={store}
      executions={[
        {
          id: 'x1',
          project: 'p1',
          experimentId: experiment.id,
          name: 'train-seed-1',
          status: 'failed',
          startedAt: 2,
        } as never,
      ]}
      onOpen={() => {}}
    />,
  );
  const table = screen.getByRole('table');
  expect(within(table).getByText('train-seed-1')).toBeTruthy();
  expect(within(table).getByText('失败')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '已归档' })).toBeNull();
});
