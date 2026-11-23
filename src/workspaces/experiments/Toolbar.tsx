import { useState, type MouseEvent } from 'react';
import {
  Check,
  ChevronDown,
  CircleX,
  FileCode2,
  FolderClosed,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  GitFork,
  History,
  ListTodo,
  MoreHorizontal,
  Play,
  Plus,
  SaveAll,
  Settings2,
  Square,
  TerminalSquare,
} from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import { Spinner, StateLabel } from '../../components/feedback';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { Modal } from '../../components/Modal';
import type { Experiment } from '../../domain/workspace';
import type { GitSnapshot } from '../../platform/git';
import type { WorkspaceStore } from '../../stores/workspace';
import { t, translateError } from '../../i18n';
import { displayPath } from '../../platform/os';
import { errorMessage } from '../../domain/errors';
import type { RunConfiguration } from './runtime';

const below = (event: MouseEvent<HTMLElement>): MenuAnchor => {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4, trigger: event.currentTarget };
};

/** PyCharm's project widget: the current folder, and where to get another. */
export function FolderWidget({
  folders,
  current,
  readOnly,
  onSwitch,
  onOpenFolder,
  onClone,
  onNewFolder,
  onManage,
}: {
  folders: Experiment[];
  current?: Experiment;
  readOnly: boolean;
  onSwitch(folder: Experiment): void;
  onOpenFolder(): void;
  onClone(): void;
  onNewFolder(): void;
  onManage(): void;
}) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  return (
    <>
      <Button
        variant="ghost"
        className="sf-ide-widget is-folder"
        aria-label={t('代码文件夹：{name}', { name: current?.name ?? '' })}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title={current?.root && displayPath(current.root)}
        onClick={(event) => setMenu(below(event))}
      >
        <FolderClosed size={14} />
        <span>{current?.name ?? t('代码文件夹')}</span>
        <ChevronDown size={12} className="sf-ide-widget-caret" />
      </Button>
      <Menu anchor={menu} label={t('代码文件夹')} onClose={() => setMenu(null)}>
        {folders.map((folder) => (
          <Button
            key={folder.id}
            variant="ghost"
            role="menuitemradio"
            aria-checked={folder.id === current?.id}
            title={displayPath(folder.root)}
            onClick={() => onSwitch(folder)}
          >
            <span className="sf-ide-menu-check">
              {folder.id === current?.id ? <Check size={13} /> : null}
            </span>
            {folder.name}
          </Button>
        ))}
        <div role="separator" className="sf-menu-separator" />
        <Button variant="ghost" role="menuitem" disabled={readOnly} onClick={onOpenFolder}>
          <FolderOpen size={14} />
          {t('打开文件夹…')}
        </Button>
        <Button variant="ghost" role="menuitem" disabled={readOnly} onClick={onClone}>
          <GitFork size={14} />
          {t('克隆 Git 仓库…')}
        </Button>
        <Button variant="ghost" role="menuitem" disabled={readOnly} onClick={onNewFolder}>
          <FolderPlus size={14} />
          {t('新建空文件夹…')}
        </Button>
        <div role="separator" className="sf-menu-separator" />
        <Button variant="ghost" role="menuitem" onClick={onManage}>
          <Settings2 size={14} />
          {t('管理文件夹')}
        </Button>
      </Menu>
    </>
  );
}

/** The current branch; checking out a branch that lives in another folder opens that folder. */
export function BranchWidget({
  snapshot,
  readOnly,
  onInit,
  onCheckout,
  onCreate,
  onWorktree,
  onGraph,
  onOpenRoot,
}: {
  snapshot: GitSnapshot | null;
  readOnly: boolean;
  onInit(): void;
  onCheckout(branch: string): void;
  onCreate(): void;
  onWorktree(): void;
  onGraph(): void;
  onOpenRoot(root: string): void;
}) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  if (!snapshot) return null;
  const elsewhere = new Map(
    snapshot.worktrees
      .filter((tree) => tree.branch && tree.root !== snapshot.root && !tree.missing)
      .map((tree) => [tree.branch!, tree.root]),
  );
  const label = !snapshot.repository
    ? t('Git')
    : (snapshot.branch ?? (snapshot.head ? snapshot.head.slice(0, 8) : t('无提交')));
  return (
    <>
      <Button
        variant="ghost"
        className="sf-ide-widget"
        aria-label={t('分支：{name}', { name: label })}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(event) => setMenu(below(event))}
      >
        <GitBranch size={14} />
        <span>{label}</span>
        <ChevronDown size={12} className="sf-ide-widget-caret" />
      </Button>
      <Menu anchor={menu} label={t('分支')} onClose={() => setMenu(null)}>
        {!snapshot.repository ? (
          <Button variant="ghost" role="menuitem" disabled={readOnly} onClick={onInit}>
            <Plus size={14} />
            {t('初始化 Git 仓库')}
          </Button>
        ) : (
          <>
            {snapshot.branches.map((branch) => (
              <Button
                key={branch.name}
                variant="ghost"
                role="menuitemradio"
                aria-checked={branch.current}
                disabled={readOnly && !elsewhere.has(branch.name)}
                title={elsewhere.get(branch.name)}
                onClick={() => {
                  if (branch.current) return;
                  const root = elsewhere.get(branch.name);
                  if (root) onOpenRoot(root);
                  else onCheckout(branch.name);
                }}
              >
                <span className="sf-ide-menu-check">
                  {branch.current ? <Check size={13} /> : null}
                </span>
                <span className="sf-ide-menu-label">{branch.name}</span>
                {elsewhere.has(branch.name) ? (
                  <FolderGit2 size={13} className="sf-ide-menu-trailing" aria-label={t('工作树')} />
                ) : null}
              </Button>
            ))}
            <div role="separator" className="sf-menu-separator" />
            <Button variant="ghost" role="menuitem" disabled={readOnly} onClick={onCreate}>
              <GitBranchPlus size={14} />
              {t('创建新分支…')}
            </Button>
            <Button variant="ghost" role="menuitem" disabled={readOnly} onClick={onWorktree}>
              <FolderGit2 size={14} />
              {t('在新文件夹中检出分支…')}
            </Button>
            <Button variant="ghost" role="menuitem" onClick={onGraph}>
              <History size={14} />
              {t('打开 Git 图')}
            </Button>
          </>
        )}
      </Menu>
    </>
  );
}

/** PyCharm's run widget: configuration, run, stop, and a menu for the rest. */
export function RunWidget({
  configurations,
  current,
  currentFile,
  disabled,
  starting,
  running,
  outcome,
  unavailable,
  onSelect,
  onRun,
  onRunFile,
  onStop,
  onEdit,
  onNew,
  onTerminal,
  onSaveAll,
  onTasks,
  onGraph,
}: {
  configurations: RunConfiguration[];
  current?: RunConfiguration;
  currentFile?: string | null;
  disabled: boolean;
  starting: boolean;
  running: boolean;
  /** How the last run ended, shown for a moment on the run button. */
  outcome?: 'done' | 'failed' | null;
  unavailable: boolean;
  onSelect(id: string): void;
  onRun(): void;
  onRunFile(): void;
  onStop(): void;
  onEdit(): void;
  onNew(): void;
  onTerminal(): void;
  onSaveAll(): void;
  onTasks(): void;
  onGraph(): void;
}) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [more, setMore] = useState<MenuAnchor | null>(null);
  const pythonFile = currentFile?.endsWith('.py') ? currentFile : null;
  return (
    <div className="sf-ide-run">
      <Button
        variant="ghost"
        className="sf-ide-widget"
        aria-label={t('运行配置：{name}', { name: current?.name ?? t('无') })}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(event) => setMenu(below(event))}
      >
        <FileCode2 size={14} />
        <span>{current?.name ?? t('添加运行配置…')}</span>
        <ChevronDown size={12} className="sf-ide-widget-caret" />
      </Button>
      <Menu anchor={menu} label={t('运行配置')} onClose={() => setMenu(null)}>
        {configurations.map((configuration) => (
          <Button
            key={configuration.id}
            variant="ghost"
            role="menuitemradio"
            aria-checked={configuration.id === current?.id}
            title={[configuration.executable, ...configuration.args].join(' ')}
            onClick={() => onSelect(configuration.id)}
          >
            <span className="sf-ide-menu-check">
              {configuration.id === current?.id ? <Check size={13} /> : null}
            </span>
            {configuration.name}
          </Button>
        ))}
        {configurations.length ? <div role="separator" className="sf-menu-separator" /> : null}
        {pythonFile ? (
          <Button
            variant="ghost"
            role="menuitem"
            disabled={disabled || unavailable}
            onClick={onRunFile}
          >
            <Play size={14} />
            {t('在终端运行 {name}', { name: pythonFile.split('/').at(-1)! })}
          </Button>
        ) : null}
        <Button variant="ghost" role="menuitem" disabled={!current} onClick={onEdit}>
          <Settings2 size={14} />
          {t('编辑运行配置…')}
        </Button>
        <Button variant="ghost" role="menuitem" disabled={disabled} onClick={onNew}>
          <Plus size={14} />
          {t('新建运行配置…')}
        </Button>
      </Menu>
      <Button
        variant="ghost"
        iconOnly
        className="sf-ide-run-start"
        aria-label={t('运行')}
        tooltip={t(
          unavailable ? '本地执行仅在桌面应用可用' : starting ? '启动中…' : '运行 (Ctrl+F5)',
        )}
        disabled={disabled || starting || unavailable}
        onClick={onRun}
      >
        <StateLabel
          state={starting ? 'starting' : running ? 'running' : (outcome ?? 'idle')}
          labels={{
            idle: <Play size={15} />,
            starting: <Spinner />,
            running: <span className="sf-pulse-dot" />,
            done: <Check size={15} className="sf-run-done" />,
            failed: <CircleX size={15} className="sf-run-failed" />,
          }}
        />
      </Button>
      <Button
        variant="ghost"
        iconOnly
        className="sf-ide-run-stop"
        aria-label={t('停止运行')}
        disabled={!running}
        onClick={onStop}
      >
        <Square size={13} />
      </Button>
      <Button
        variant="ghost"
        iconOnly
        aria-label={t('更多操作')}
        aria-haspopup="menu"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMore({ x: rect.right - 200, y: rect.bottom + 4, trigger: event.currentTarget });
        }}
      >
        <MoreHorizontal size={15} />
      </Button>
      <Menu anchor={more} label={t('更多操作')} onClose={() => setMore(null)}>
        <Button
          variant="ghost"
          role="menuitem"
          disabled={disabled || unavailable}
          onClick={onTerminal}
        >
          <TerminalSquare size={14} />
          {t('新建终端')}
        </Button>
        <Button variant="ghost" role="menuitem" disabled={disabled} onClick={onSaveAll}>
          <SaveAll size={14} />
          {t('保存全部')}
        </Button>
        <div role="separator" className="sf-menu-separator" />
        <Button variant="ghost" role="menuitem" onClick={onGraph}>
          <History size={14} />
          {t('打开 Git 图')}
        </Button>
        <Button variant="ghost" role="menuitem" onClick={onTasks}>
          <ListTodo size={14} />
          {t('后台任务')}
        </Button>
      </Menu>
    </div>
  );
}

/** VS Code's "Clone Repository": an address, then where to put it. */
export function CloneDialog({
  store,
  onClose,
  onClone,
}: {
  store: WorkspaceStore;
  onClose(): void;
  onClone(url: string, parent?: string): Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={t('克隆 Git 仓库')} onClose={onClose} busy={busy} dirty={!!url.trim()}>
      <form
        className="sf-experiment-config-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!url.trim()) return;
          setBusy(true);
          setError('');
          try {
            await onClone(url.trim(), parent || undefined);
          } catch (reason) {
            setError(errorMessage(reason));
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <label>
            {t('仓库地址')}
            <Input
              autoFocus
              required
              value={url}
              placeholder="https://github.com/owner/repository.git"
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label>
            {t('保存位置')}
            <div className="sf-experiment-directory-input">
              <Input readOnly value={parent || t('Capsio 数据目录')} aria-label={t('保存位置')} />
              <Button
                type="button"
                iconOnly
                aria-label={t('选择目录')}
                onClick={async () => {
                  try {
                    const value = await store.getState().chooseDirectory();
                    if (value) setParent(value);
                  } catch (reason) {
                    setError(errorMessage(reason));
                  }
                }}
              >
                <FolderOpen size={16} />
              </Button>
            </div>
          </label>
        </fieldset>
        {error && <p role="alert">{translateError(error)}</p>}
        <footer>
          <span className="spacer" />
          <Button type="button" disabled={busy} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !url.trim()}>
            {t(busy ? '正在克隆…' : '克隆')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
