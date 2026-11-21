import { canEditProject } from '../../platform/collaboration';
import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Archive, ArchiveRestore, FolderOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { Experiment, Project, Workspace } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import { Button, Dropdown, Input, Textarea, segmentThumb } from '../../components/primitives';
import { Modal } from '../../components/Modal';
import { toastUndo } from '../../components/feedback';
import { t, translateError } from '../../i18n';
import { displayPath } from '../../platform/os';
import { relativeTime } from '../../features/projects/model';
import { statusLabel } from './status';
import { experimentsFor, experimentCatalog, registerExperiment } from './catalog';
import { type Execution } from './runtime';
import { developmentStore } from './development';
import { errorMessage } from '../../domain/errors';

/** Runs that belong to an experiment, newest first. */
function runsOfExperiment(project: Project, experiment: Experiment, executions: Execution[]) {
  return executions
    .filter(
      (run) =>
        run.experimentId === experiment.id ||
        (!run.experimentId &&
          (experiment.root ? run.workspaceRoot === experiment.root : run.project === project.id)),
    )
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function ExperimentManager({
  project,
  store,
  executions,
  onOpen,
}: {
  project: Project;
  store: WorkspaceStore;
  executions: Execution[];
  onOpen(experiment: Experiment): void;
}) {
  const readOnly = !canEditProject(project, 'code');
  const data = useStore(store, (state) => state.data);
  const development = useStore(developmentStore);
  const experiments = experimentsFor(data, project.id);
  const [query, setQuery] = useState('');
  const [archivedView, setArchivedView] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A folder is renamed in its own row; the ref keeps Enter and the blur after it from both saving.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const renamingId = useRef<string | null>(null);
  const archivedCount = experiments.filter((e) => e.archived).length;
  const archived = archivedView && archivedCount > 0;
  /** Whether runs, terminals, tasks or chats of this folder are still going. */
  function inUse(experiment: Experiment) {
    const running = executions.some(
      (run) =>
        run.status === 'running' &&
        (run.experimentId === experiment.id ||
          (experiment.root && run.workspaceRoot === experiment.root)),
    );
    const chats = data?.sessions.filter((chat) => chat.experimentId === experiment.id) ?? [];
    return (
      running ||
      development.terminals.some(
        (item) => item.experimentId === experiment.id && item.status === 'running',
      ) ||
      development.tasks.some(
        (item) => item.experimentId === experiment.id && item.status === 'running',
      ) ||
      chats.some((chat) => store.getState().agentTasks[`${project.id}:${chat.id}`])
    );
  }
  async function save(change: (draft: Workspace) => void) {
    setBusy(true);
    try {
      if (!(await store.getState().update(change)))
        throw new Error(store.getState().error ?? t('保存失败'));
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const target = (draft: Workspace, id: string) => {
    const found = draft.experiments?.find((e) => e.id === id);
    if (!found) throw new Error(t('实验不存在。'));
    return found;
  };
  function startRename(experiment: Experiment) {
    renamingId.current = experiment.id;
    setRenaming({ id: experiment.id, value: experiment.name });
  }
  function stopRename() {
    renamingId.current = null;
    setRenaming(null);
  }
  async function rename(experiment: Experiment, value: string) {
    if (renamingId.current !== experiment.id) return;
    stopRename();
    const name = value.trim();
    if (!name || name === experiment.name) return;
    setError('');
    await save((draft) => {
      const found = target(draft, experiment.id);
      found.name = name;
      found.updatedAt = new Date().toISOString();
    });
  }
  /** Archives or brings back a folder at once; the toast takes it back. */
  async function archive(experiment: Experiment) {
    setError('');
    if (inUse(experiment)) return setError(t('请先停止此文件夹的 AI 和运行任务。'));
    const archived = !experiment.archived;
    const mark = (value: boolean) => (draft: Workspace) => {
      const found = target(draft, experiment.id);
      found.archived = value;
      found.updatedAt = new Date().toISOString();
    };
    if (await save(mark(archived)))
      toastUndo(
        t(archived ? '已归档“{name}”' : '已恢复“{name}”', { name: experiment.name }),
        async () => void (await save(mark(!archived))),
      );
  }
  /** Only the folder's entry leaves the project; files, commits, chats and runs stay, so undo puts it back. */
  async function remove(experiment: Experiment) {
    setError('');
    if (inUse(experiment)) return setError(t('请先停止此文件夹的 AI 和运行任务。'));
    const kept = structuredClone(experiment);
    const index = experiments.findIndex((e) => e.id === experiment.id);
    const ok = await save((draft) => {
      target(draft, experiment.id);
      draft.experiments = draft.experiments?.filter((e) => e.id !== experiment.id);
    });
    if (ok)
      toastUndo(
        t('已从项目中移除“{name}”', { name: experiment.name }),
        async () =>
          void (await save((draft) => {
            const list = (draft.experiments ??= []);
            if (!list.some((e) => e.id === kept.id))
              list.splice(Math.max(0, Math.min(index, list.length)), 0, kept);
          })),
      );
  }
  const visible = experiments.filter(
    (e) =>
      !!e.archived === archived &&
      `${e.name} ${e.purpose}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="sf-page sf-experiment-manager" aria-label={t('管理文件夹')}>
      <header className="sf-page-head">
        <h1 className="sf-page-title">
          {t('代码文件夹')}
          <span className="sf-page-count">{visible.length}</span>
        </h1>
        <span className="spacer" />
        {archivedCount ? (
          <div
            ref={segmentThumb}
            className="sf-segmented"
            role="group"
            aria-label={t('文件夹状态')}
          >
            <Button variant="ghost" aria-pressed={!archived} onClick={() => setArchivedView(false)}>
              {t('进行中')}
            </Button>
            <Button variant="ghost" aria-pressed={archived} onClick={() => setArchivedView(true)}>
              {t('已归档')}
            </Button>
          </div>
        ) : null}
        <label className="sf-search-field">
          <Search />
          <Input
            aria-label={t('搜索文件夹')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('搜索文件夹')}
          />
        </label>
        <Button
          variant="primary"
          disabled={readOnly || busy || !experimentCatalog.available()}
          onClick={() => setCreating(true)}
        >
          <Plus size={15} />
          {t('添加文件夹')}
        </Button>
      </header>
      {error && (
        <p role="alert" className="sf-page-error">
          {translateError(error)}
        </p>
      )}
      {visible.length ? (
        <div className="sf-table-scroll">
          <table className="sf-table sf-experiment-table">
            <colgroup>
              <col />
              <col style={{ width: 128 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 168 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 132 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t('文件夹')}</th>
                <th scope="col">{t('状态')}</th>
                <th scope="col">Python</th>
                <th scope="col">{t('最近运行')}</th>
                <th scope="col">{t('更新')}</th>
                <th scope="col">
                  <span className="sf-visually-hidden">{t('操作')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((experiment) => {
                const runs = runsOfExperiment(project, experiment, executions);
                const active =
                  runs.filter((r) => r.status === 'running').length +
                  development.terminals.filter(
                    (item) => item.experimentId === experiment.id && item.status === 'running',
                  ).length +
                  development.tasks.filter(
                    (item) => item.experimentId === experiment.id && item.status === 'running',
                  ).length;
                const latest = runs[0];
                const where = displayPath(experiment.root || project.path || project.repo || '');
                return (
                  <tr
                    key={experiment.id}
                    className={experiment.archived ? 'is-archived' : ''}
                    onDoubleClick={() => {
                      if (!experiment.archived) onOpen(experiment);
                    }}
                  >
                    <td className="sf-experiment-name" title={where}>
                      {renaming?.id === experiment.id ? (
                        <Input
                          autoFocus
                          className="sf-experiment-rename"
                          aria-label={t('重命名文件夹')}
                          maxLength={200}
                          value={renaming.value}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) =>
                            setRenaming({ id: experiment.id, value: event.target.value })
                          }
                          onBlur={() => void rename(experiment, renaming.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void rename(experiment, renaming.value);
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              stopRename();
                            }
                          }}
                        />
                      ) : (
                        <Button
                          variant="ghost"
                          disabled={experiment.archived}
                          onClick={() => onOpen(experiment)}
                        >
                          <span>{experiment.name}</span>
                        </Button>
                      )}
                      {experiment.purpose ? <small>{experiment.purpose}</small> : null}
                    </td>
                    <td>
                      {experiment.archived ? (
                        t('已归档')
                      ) : active ? (
                        <span className="sf-state" data-status="running">
                          {t('{count} 个任务运行中', { count: active })}
                        </span>
                      ) : latest ? (
                        <span className="sf-state" data-status={latest.status}>
                          {statusLabel(latest.status)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {experiment.python
                        ? `${experiment.python.version} · ${experiment.python.manager}`
                        : t('未配置')}
                    </td>
                    <td>{latest?.name ?? '—'}</td>
                    <td>{relativeTime(experiment.updatedAt) || '—'}</td>
                    <td>
                      <div className="sf-row-actions">
                        <Button
                          variant="ghost"
                          iconOnly
                          tooltip={t('打开文件夹')}
                          aria-label={t('打开文件夹')}
                          disabled={busy || experiment.archived}
                          onClick={() => onOpen(experiment)}
                        >
                          <FolderOpen size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          iconOnly
                          tooltip={t('重命名文件夹')}
                          aria-label={t('重命名文件夹')}
                          disabled={readOnly || busy}
                          onClick={() => startRename(experiment)}
                        >
                          <Pencil size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          iconOnly
                          tooltip={t(experiment.archived ? '恢复文件夹' : '归档文件夹')}
                          aria-label={t(experiment.archived ? '恢复文件夹' : '归档文件夹')}
                          disabled={readOnly || busy}
                          onClick={() => void archive(experiment)}
                        >
                          {experiment.archived ? (
                            <ArchiveRestore size={15} />
                          ) : (
                            <Archive size={15} />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          iconOnly
                          tooltip={t('从项目中移除')}
                          aria-label={t('从项目中移除')}
                          disabled={readOnly || busy}
                          onClick={() => void remove(experiment)}
                        >
                          <Trash2 size={15} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="sf-page-empty">{query ? t('没有匹配的文件夹') : t('暂无代码文件夹')}</div>
      )}
      {creating && (
        <ExperimentForm
          project={project}
          store={store}
          onClose={() => setCreating(false)}
          onSaved={(experiment) => {
            setCreating(false);
            onOpen(experiment);
          }}
        />
      )}
    </section>
  );
}

function ExperimentForm({
  project,
  store,
  onClose,
  onSaved,
}: {
  project: Project;
  store: WorkspaceStore;
  onClose(): void;
  onSaved(experiment: Experiment): void;
}) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [source, setSource] = useState<'empty' | 'existing'>('empty');
  const [directory, setDirectory] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    if (!name.trim() || (source === 'existing' && !directory)) return;
    setSaving(true);
    setError('');
    try {
      onSaved(
        await registerExperiment(store, project.id, name, purpose, source, directory || undefined),
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title={t('添加文件夹')} onClose={onClose} busy={saving} dirty={dirty}>
      <form
        className="sf-experiment-config-form"
        onChange={() => setDirty(true)}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={saving}>
          <label>
            {t('名称')}
            <Input
              autoFocus
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t('用途')}
            <Textarea
              rows={3}
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
            />
          </label>
          <label>
            {t('来源')}
            <Dropdown
              value={source}
              onChange={(event) => setSource(event.target.value as typeof source)}
            >
              <option value="empty">{t('新建空文件夹')}</option>
              <option value="existing">{t('打开已有文件夹')}</option>
            </Dropdown>
          </label>
          {source === 'existing' && (
            <label>
              {t('文件夹位置')}
              <div className="sf-experiment-directory-input">
                <Input
                  required
                  value={directory}
                  onChange={(event) => setDirectory(event.target.value)}
                />
                <Button
                  type="button"
                  iconOnly
                  aria-label={t('选择目录')}
                  onClick={async () => {
                    try {
                      const value = await store.getState().chooseDirectory();
                      if (value) {
                        setDirectory(value);
                        setDirty(true);
                      }
                    } catch (reason) {
                      setError(errorMessage(reason));
                    }
                  }}
                >
                  <FolderOpen size={16} />
                </Button>
              </div>
            </label>
          )}
        </fieldset>
        {error && <p role="alert">{translateError(error)}</p>}
        <footer>
          <span className="spacer" />
          <Button type="button" disabled={saving} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={saving || !name.trim() || (source === 'existing' && !directory)}
          >
            {t(saving ? '保存中…' : '添加')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
