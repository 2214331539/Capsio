import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { canEditProject } from '../../platform/collaboration';
import { directorySessions, reloadDirectorySessions } from '../../editor/sessions';
import { gitApi, type GitAction } from '../../platform/git';
import type { ResearchBackend } from '../../platform/research';
import type { WorkspaceStore } from '../../stores/workspace';
import { t } from '../../i18n';
import { errorMessage } from '../../domain/errors';
import type { useCodeWorkspace } from './code-context';
import { beginGitOperation, gitDraftKey, gitDrafts, setGitMessage } from './git-drafts';

/** Git actions on the selected folder, shared by Source Control and the Git tab. */
export function useGitActions({
  projectId,
  backend,
  store,
  code,
}: {
  projectId: string;
  backend: ResearchBackend;
  store: WorkspaceStore;
  code: ReturnType<typeof useCodeWorkspace>;
}) {
  const { root, refresh } = code;
  const binding = gitDraftKey(projectId, root ?? '');
  const drafts = gitDrafts(store);
  const message = useStore(drafts, (state) => state.messages[binding] ?? '');
  const pending = useStore(drafts, (state) => !!state.pending[binding]);
  const project = useStore(store, (state) => state.data?.projects.find((p) => p.id === projectId));
  const blocked = pending || !!code.error || !canEditProject(project, 'code');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const current = useRef(binding);
  current.current = binding;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setError('');
    setResult('');
  }, [binding]);
  /** Runs the requests in order under one lock; stops at the first failure. */
  async function execute(...requests: GitAction[]) {
    if (!root || blocked || !requests.length) return false;
    const dirtyRoot = requests[0].kind === 'worktree-remove' ? requests[0].target : root;
    const sessions = directorySessions(backend, projectId, dirtyRoot, true);
    if (
      sessions.some(
        (session) =>
          session.getSnapshot().dirty ||
          ['loading', 'saving'].includes(session.getSnapshot().phase),
      )
    ) {
      setError(t('此目录有未保存或正在读写的文件，请先保存后再执行 Git 操作。'));
      return false;
    }
    const finish = beginGitOperation(store, binding);
    if (!finish) return false;
    setError('');
    setResult('');
    const operationBinding = binding;
    try {
      let output = '';
      for (const request of requests) output = await gitApi.action(projectId, root, request);
      await reloadDirectorySessions(backend, projectId, dirtyRoot);
      const last = requests.at(-1)!;
      if (last.kind === 'commit' && drafts.getState().messages[operationBinding] === last.message)
        setGitMessage(store, operationBinding, '');
      refresh();
      if (mounted.current && current.current === operationBinding)
        setResult(
          last.kind === 'commit'
            ? `Commit ${output.trim().slice(0, 12)}`
            : output.trim() || t('操作完成'),
        );
      return true;
    } catch (e) {
      if (mounted.current && current.current === operationBinding) {
        setError(errorMessage(e));
        refresh();
      }
      return false;
    } finally {
      finish();
    }
  }
  return {
    binding,
    message,
    setMessage: (value: string) => setGitMessage(store, binding, value),
    blocked,
    error,
    setError,
    result,
    setResult,
    execute,
  };
}
