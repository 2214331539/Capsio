import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import {
  Box,
  Check,
  CornerDownLeft,
  FolderPlus,
  Package,
  Search,
  Square,
  SquarePen,
} from 'lucide-react';
import { Input } from '../../components/primitives';
import { Modal } from '../../components/Modal';
import { ResourceList, ResourceRow } from '../../components/workspace/ResourceList';
import { confirmAction } from '../../components/prompts';
import type { Experiment } from '../../domain/workspace';
import type { ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import { displayPath } from '../../platform/os';
import { t, translateError } from '../../i18n';
import { errorMessage } from '../../domain/errors';
import {
  bindInterpreter,
  developmentApi,
  developmentStore,
  ensureExecutionTrust,
  type EnvironmentTask,
  type Interpreter,
} from './development';
import '../../features/search/search.css';

type Step = 'pick' | 'path' | 'kind' | 'venv' | 'conda';
type Item = {
  key: string;
  icon: ReactNode;
  title: string;
  detail?: string;
  current?: boolean;
  run(): void;
};

/**
 * VS Code's "Python: Select Interpreter": found interpreters, a path, or a new environment,
 * opened from the status bar. Dependencies the folder declares can be installed from here too.
 */
export function InterpreterPicker({
  projectId,
  experiment,
  store,
  backend,
  root,
  onStarted,
  onClose,
}: {
  projectId: string;
  experiment: Experiment;
  store: WorkspaceStore;
  backend: ResearchBackend;
  root?: string;
  onStarted(task: EnvironmentTask): void;
  onClose(): void;
}) {
  const [step, setStep] = useState<Step>('pick');
  const [query, setQuery] = useState('');
  const [interpreters, setInterpreters] = useState<Interpreter[] | null>(null);
  const [conda, setConda] = useState(false);
  const [declared, setDeclared] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The environment task this folder is waiting for, if any; it can be stopped from here.
  const running = useStore(developmentStore, (state) =>
    state.tasks.find((task) => task.experimentId === experiment.id && task.status === 'running'),
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        if (!(await ensureExecutionTrust(projectId, experiment.id))) return onClose();
        const found = await developmentApi.python<{
          interpreters: Interpreter[];
          condaAvailable: boolean;
        }>(projectId, experiment.id, { action: 'discover' });
        if (!alive.current) return;
        setInterpreters(found.interpreters);
        setConda(found.condaAvailable);
      } catch (reason) {
        if (alive.current) {
          setInterpreters([]);
          setError(errorMessage(reason));
        }
      }
    })();
    void backend
      .listFiles(projectId, root)
      .then((files) => {
        if (alive.current) setDeclared(new Set(files.map((file) => file.path)));
      })
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  }, [projectId, experiment.id, root]);
  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (reason) {
      if (alive.current) setError(errorMessage(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const select = (executable: string) =>
    perform(async () => {
      const info = await developmentApi.python<Interpreter>(projectId, experiment.id, {
        action: 'inspect',
        executable,
      });
      await bindInterpreter(store, experiment.id, info);
      onClose();
    });
  const start = (kind: string, request: object = {}) =>
    perform(async () => {
      if (
        experiment.python?.manager === 'system' &&
        !['venv', 'conda'].includes(kind) &&
        !(await confirmAction(
          t('当前选择的是系统 Python，安装或删除包将影响其他使用此环境的项目。继续？'),
        ))
      )
        return;
      const task = await developmentApi.python<EnvironmentTask>(projectId, experiment.id, {
        action: 'start',
        kind,
        packages: [],
        ...request,
      });
      developmentStore.setState((data) => ({
        tasks: [...data.tasks.filter((item) => item.id !== task.id), task],
      }));
      store.getState().setAgentTask(`python:${task.id}`, projectId);
      onStarted(task);
      onClose();
    });
  const interpreterItem = (info: Interpreter, run: () => void): Item => ({
    key: info.executable,
    icon: <Box size={16} />,
    title: `Python ${info.version}${info.manager === 'system' ? '' : ` (${info.manager})`}`,
    detail: displayPath(info.executable),
    current: info.executable === experiment.python?.executable,
    run,
  });
  const groups: { label?: string; items: Item[] }[] =
    step === 'pick'
      ? [
          {
            items: [
              ...(running
                ? [
                    {
                      key: 'stop',
                      icon: <Square size={16} />,
                      title: t('停止正在进行的环境任务'),
                      detail: running.command.join(' '),
                      run: () =>
                        void perform(async () => {
                          await developmentApi.python(projectId, experiment.id, {
                            action: 'stop',
                            id: running.id,
                          });
                          onClose();
                        }),
                    },
                  ]
                : []),
              {
                key: 'path',
                icon: <SquarePen size={16} />,
                title: t('输入解释器路径…'),
                run: () => {
                  setQuery('');
                  setStep('path');
                },
              },
              {
                key: 'create',
                icon: <FolderPlus size={16} />,
                title: t('创建虚拟环境…'),
                run: () => {
                  setQuery('');
                  setStep(conda ? 'kind' : 'venv');
                },
              },
            ],
          },
          {
            label: t('依赖'),
            items: !experiment.python
              ? []
              : (
                  [
                    declared.has('requirements.txt') && {
                      key: 'requirements',
                      icon: <Package size={16} />,
                      title: t('安装 requirements.txt 中的依赖'),
                      run: () => void start('requirements', { target: 'requirements.txt' }),
                    },
                    (declared.has('pyproject.toml') || declared.has('setup.py')) && {
                      key: 'editable',
                      icon: <Package size={16} />,
                      title: t('以可编辑模式安装此文件夹（pip install -e .）'),
                      run: () => void start('editable'),
                    },
                    experiment.python.manager === 'conda' &&
                      declared.has('environment.yml') && {
                        key: 'conda-update',
                        icon: <Package size={16} />,
                        title: t('按 environment.yml 更新环境'),
                        run: () => void start('condaUpdate'),
                      },
                  ] as (Item | false)[]
                ).filter((item): item is Item => !!item),
          },
          {
            label: t('解释器'),
            items: [
              ...(interpreters ?? []),
              ...(experiment.python &&
              !interpreters?.some((item) => item.executable === experiment.python?.executable)
                ? [experiment.python]
                : []),
            ].map((info) => interpreterItem(info, () => void select(info.executable))),
          },
        ]
      : step === 'kind'
        ? [
            {
              items: [
                {
                  key: 'venv',
                  icon: <FolderPlus size={16} />,
                  title: 'Venv',
                  detail: t('在当前文件夹创建 .venv'),
                  run: () => setStep('venv'),
                },
                {
                  key: 'conda',
                  icon: <FolderPlus size={16} />,
                  title: 'Conda',
                  detail: t('在当前文件夹创建 .conda'),
                  run: () => setStep('conda'),
                },
              ],
            },
          ]
        : step === 'venv'
          ? [
              {
                label: t('选择创建环境所用的 Python'),
                items: (interpreters ?? [])
                  .filter((info) => info.manager !== 'venv')
                  .map((info) =>
                    interpreterItem(
                      info,
                      () => void start('venv', { base: info.executable, target: '.venv' }),
                    ),
                  ),
              },
            ]
          : step === 'conda'
            ? [
                {
                  label: t('选择 Python 版本'),
                  items: ['3.12', '3.11', '3.10'].map((version) => ({
                    key: version,
                    icon: <Box size={16} />,
                    title: `Python ${version}`,
                    run: () => void start('conda', { pythonVersion: version, target: '.conda' }),
                  })),
                },
              ]
            : [];
  const needle = query.trim().toLowerCase();
  const visible = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        `${item.title} ${item.detail ?? ''}`.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.items.length);
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || event.nativeEvent.isComposing)
      return;
    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '.sf-search-result:not(:disabled)',
      ),
    ];
    const fromField = (event.target as HTMLElement).tagName === 'INPUT';
    if (event.key === 'Enter') {
      if (!fromField) return;
      event.preventDefault();
      if (step === 'path') {
        if (query.trim()) void select(query.trim());
      } else rows[0]?.click();
      return;
    }
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
    if (next < 0) (event.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus();
    else rows[Math.min(next, rows.length - 1)]?.focus();
  }
  return (
    <Modal title={t('选择 Python 解释器')} className="sf-palette" busy={busy} onClose={onClose}>
      <div className="sf-search-dialog" onKeyDown={keys}>
        <label className="sf-search-query">
          <Search size={18} />
          <Input
            autoFocus
            key={step}
            aria-label={t('选择 Python 解释器')}
            placeholder={
              step === 'path'
                ? t('输入 Python 可执行文件的路径')
                : experiment.python
                  ? t('当前：{path}', { path: displayPath(experiment.python.executable) })
                  : t('选择 Python 解释器')
            }
            value={query}
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>Esc</kbd>
        </label>
        {error ? (
          <p className="sf-search-error" role="alert">
            {translateError(error)}
          </p>
        ) : null}
        <div className="sf-search-results" aria-busy={interpreters === null || busy}>
          {step === 'path' ? null : interpreters === null && step === 'pick' ? (
            <p className="sf-search-empty">{t('正在查找解释器…')}</p>
          ) : visible.length ? (
            visible.map((group, index) => (
              <div className="sf-search-group" key={group.label ?? index}>
                {group.label ? <h3>{group.label}</h3> : null}
                <ResourceList label={group.label ?? t('操作')}>
                  {group.items.map((item) => (
                    <ResourceRow
                      key={item.key}
                      className="sf-search-result"
                      title={item.detail}
                      disabled={busy}
                      aria-current={item.current || undefined}
                      onClick={item.run}
                    >
                      {item.icon}
                      <span>
                        <strong>{item.title}</strong>
                        {item.detail ? <small>{item.detail}</small> : null}
                      </span>
                      {item.current ? <Check size={14} aria-label={t('当前')} /> : null}
                      <CornerDownLeft size={13} className="sf-search-enter" aria-hidden="true" />
                    </ResourceRow>
                  ))}
                </ResourceList>
              </div>
            ))
          ) : (
            <p className="sf-search-empty">{t('没有匹配的项目')}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
