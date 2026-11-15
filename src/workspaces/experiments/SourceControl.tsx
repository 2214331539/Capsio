import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  FileText,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { Button, Textarea } from '../../components/primitives';
import { confirmAction } from '../../components/prompts';
import { gitApi, type GitAction } from '../../platform/git';
import type { GitChange, ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import { t, translateError } from '../../i18n';
import { errorMessage } from '../../domain/errors';
import { relativeTime } from '../../features/projects/model';
import type { useCodeWorkspace } from './code-context';
import { useGitActions } from './git-actions';
import { changeSides, Patch } from './GitWorkspace';
import { SideSection } from './SideSection';

const name = (path: string) => path.split('/').at(-1) ?? path;
const folder = (path: string) => path.split('/').slice(0, -1).join('/');

/** The letter and color VS Code shows next to a changed file. */
function changeLetter(change: GitChange, staged: boolean) {
  if (changeSides(change).conflict) return { text: '!', tone: 'conflict' };
  if (change.status === '??') return { text: 'U', tone: 'added' };
  const code = change.status[staged ? 0 : 1];
  if (code === 'A') return { text: 'A', tone: 'added' };
  if (code === 'D') return { text: 'D', tone: 'deleted' };
  if (code === 'R') return { text: 'R', tone: 'modified' };
  return { text: 'M', tone: 'modified' };
}

/** VS Code's Source Control view: message, commit, staged changes, changes, recent commits. */
export function SourceControl({
  projectId,
  backend,
  store,
  code,
  onOpenFile,
  onOpenDiff,
  onGraph,
}: {
  projectId: string;
  backend: ResearchBackend;
  store: WorkspaceStore;
  code: ReturnType<typeof useCodeWorkspace>;
  onOpenFile(path: string): void;
  onOpenDiff(path: string, staged: boolean): void;
  onGraph(): void;
}) {
  const { snapshot, loading, refresh } = code;
  const git = useGitActions({ projectId, backend, store, code });
  const { message, blocked, error, setError, result, execute } = git;
  if (!gitApi.available()) return <p className="sf-ide-empty">{t('Git 管理仅在桌面应用可用')}</p>;
  if (!snapshot)
    return (
      <p className="sf-ide-empty" role={code.error ? 'alert' : 'status'}>
        {code.error ? translateError(code.error) : t('正在读取…')}
      </p>
    );
  if (!snapshot.repository)
    return (
      <div className="sf-ide-empty">
        <p>{t('此文件夹不是 Git 仓库。')}</p>
        <Button variant="primary" disabled={blocked} onClick={() => void execute({ kind: 'init' })}>
          {t('初始化仓库')}
        </Button>
        {error ? <p role="alert">{translateError(error)}</p> : null}
      </div>
    );
  const staged = snapshot.changes.filter((change) => changeSides(change).staged);
  const changes = snapshot.changes.filter((change) => changeSides(change).unstaged);
  const conflicts = snapshot.changes.some((change) => changeSides(change).conflict);
  const stageable = changes.filter((change) => !changeSides(change).conflict);
  const canCommit = !blocked && !!message.trim() && !conflicts && snapshot.changes.length > 0;
  function commit() {
    if (!canCommit) return;
    // With nothing staged, commit every change, as VS Code's smart commit does.
    const stage: GitAction[] = staged.length
      ? []
      : stageable.map((change) => ({ kind: 'stage', path: change.path }));
    void execute(...stage, { kind: 'commit', message });
  }
  async function discard(change: GitChange) {
    try {
      const expectedDiff = await gitApi.diff(projectId, code.root!, change.path, false);
      if (await confirmAction(t('放弃“{path}”中的更改？此操作无法撤消。', { path: change.path })))
        void execute({ kind: 'restore', path: change.path, expectedDiff });
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  const row = (change: GitChange, isStaged: boolean) => {
    const letter = changeLetter(change, isStaged);
    const sides = changeSides(change);
    return (
      <div key={change.path} className="sf-scm-row">
        <Button
          variant="ghost"
          className="sf-scm-file"
          aria-label={t(isStaged ? '查看已暂存 {path}' : '查看更改 {path}', { path: change.path })}
          title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
          onClick={() => onOpenDiff(change.path, isStaged)}
        >
          <FileText size={13} aria-hidden="true" />
          <span className="sf-scm-name" data-tone={letter.tone}>
            {name(change.path)}
          </span>
          <span className="sf-scm-folder">{folder(change.path)}</span>
        </Button>
        <span className="sf-scm-actions">
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('打开文件 {path}', { path: change.path })}
            tooltip={t('打开文件')}
            onClick={() => onOpenFile(change.path)}
          >
            <ArrowUpRight size={13} />
          </Button>
          {!isStaged && change.status !== '??' && !sides.conflict ? (
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('放弃更改 {path}', { path: change.path })}
              tooltip={t('放弃更改')}
              disabled={blocked}
              onClick={() => void discard(change)}
            >
              <RotateCcw size={13} />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            iconOnly
            aria-label={t(isStaged ? '取消暂存 {path}' : '暂存 {path}', { path: change.path })}
            tooltip={t(isStaged ? '取消暂存更改' : '暂存更改')}
            disabled={blocked}
            onClick={() =>
              void execute({ kind: isStaged ? 'unstage' : 'stage', path: change.path })
            }
          >
            {isStaged ? <Minus size={13} /> : <Plus size={13} />}
          </Button>
        </span>
        <span className="sf-scm-letter" data-tone={letter.tone}>
          {letter.text}
        </span>
      </div>
    );
  };
  return (
    <div className="sf-scm">
      <form
        className="sf-scm-commit"
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
      >
        <Textarea
          aria-label={t('提交消息')}
          rows={2}
          placeholder={t('消息（Ctrl+Enter 在“{branch}”上提交）', {
            branch: snapshot.branch ?? 'HEAD',
          })}
          value={message}
          onChange={(event) => git.setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commit();
            }
          }}
        />
        <Button type="submit" variant="primary" disabled={!canCommit}>
          <Check size={14} />
          {t(staged.length || !snapshot.changes.length ? '提交' : '提交所有更改')}
        </Button>
      </form>
      {error ? (
        <p className="sf-scm-feedback" role="alert">
          {translateError(error)}
        </p>
      ) : result ? (
        <p className="sf-scm-feedback" role="status">
          {result}
        </p>
      ) : null}
      <div className="sf-scm-scroll">
        {staged.length ? (
          <SideSection
            title={t('暂存的更改')}
            count={staged.length}
            actions={
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('取消暂存所有更改')}
                tooltip={t('取消暂存所有更改')}
                disabled={blocked}
                onClick={() =>
                  void execute(
                    ...staged.map((change): GitAction => ({ kind: 'unstage', path: change.path })),
                  )
                }
              >
                <Minus size={13} />
              </Button>
            }
          >
            {staged.map((change) => row(change, true))}
          </SideSection>
        ) : null}
        <SideSection
          title={t('更改')}
          count={changes.length}
          actions={
            <>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('刷新')}
                tooltip={t('刷新')}
                disabled={loading}
                onClick={refresh}
              >
                {loading ? (
                  <LoaderCircle size={13} className="sf-ai-spinner" />
                ) : (
                  <RefreshCw size={13} />
                )}
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('暂存所有更改')}
                tooltip={t('暂存所有更改')}
                disabled={blocked || !stageable.length}
                onClick={() =>
                  void execute(
                    ...stageable.map((change): GitAction => ({ kind: 'stage', path: change.path })),
                  )
                }
              >
                <Plus size={13} />
              </Button>
            </>
          }
        >
          {changes.map((change) => row(change, false))}
          {!changes.length ? <p className="sf-ide-hint">{t('没有更改')}</p> : null}
        </SideSection>
        <SideSection
          title={t('提交')}
          actions={
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('打开 Git 图')}
              tooltip={t('打开 Git 图')}
              onClick={onGraph}
            >
              <History size={13} />
            </Button>
          }
        >
          {snapshot.history.slice(0, 12).map((commit) => (
            <Button
              key={commit.sha}
              variant="ghost"
              className="sf-scm-commit-row"
              title={`${commit.sha.slice(0, 8)} · ${commit.author}`}
              onClick={onGraph}
            >
              <GitCommitHorizontal size={13} aria-hidden="true" />
              <span>{commit.subject}</span>
              <small>{relativeTime(commit.time)}</small>
            </Button>
          ))}
          {!snapshot.history.length ? <p className="sf-ide-hint">{t('尚无提交')}</p> : null}
        </SideSection>
      </div>
    </div>
  );
}

/** A file's changes as an editor tab: the index against HEAD, or the working tree against the index. */
export function DiffView({
  projectId,
  code,
  path,
  staged,
  onOpenFile,
}: {
  projectId: string;
  code: ReturnType<typeof useCodeWorkspace>;
  path: string;
  staged: boolean;
  onOpenFile(path: string): void;
}) {
  const { root, snapshot } = code;
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!root || !gitApi.available()) return;
    let alive = true;
    setError('');
    void gitApi
      .diff(projectId, root, path, staged)
      .then((value) => {
        if (alive) setPatch(value);
      })
      .catch((reason) => {
        if (alive) setError(errorMessage(reason));
      });
    return () => {
      alive = false;
    };
  }, [projectId, root, path, staged, snapshot]);
  return (
    <div className="sf-diff-view">
      <header>
        <strong>{name(path)}</strong>
        <span>{folder(path)}</span>
        <small>{t(staged ? '已暂存' : '工作树')}</small>
        <span className="spacer" />
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('打开文件')}
          tooltip={t('打开文件')}
          onClick={() => onOpenFile(path)}
        >
          <ArrowUpRight size={14} />
        </Button>
      </header>
      {error ? (
        <p className="sf-ide-empty" role="alert">
          {translateError(error)}
        </p>
      ) : patch === null ? (
        <p className="sf-ide-empty">{t('正在读取…')}</p>
      ) : (
        <Patch patch={patch} staged={staged} />
      )}
    </div>
  );
}
