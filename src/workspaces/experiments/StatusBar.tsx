import { Box, GitBranch, LoaderCircle, Play } from 'lucide-react';
import { Button } from '../../components/primitives';
import type { GitSnapshot } from '../../platform/git';
import { displayPath } from '../../platform/os';
import { t } from '../../i18n';
import type { Interpreter } from './development';

const languages: Record<string, string> = {
  py: 'Python',
  ipynb: 'Jupyter',
  md: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  sh: 'Shell',
  ps1: 'PowerShell',
  js: 'JavaScript',
  ts: 'TypeScript',
  csv: 'CSV',
  r: 'R',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cu: 'CUDA',
  tex: 'LaTeX',
};

/** VS Code's status bar, limited to what a researcher looks for: branch, runs, interpreter. */
export function StatusBar({
  snapshot,
  running,
  path,
  interpreter,
  preparing,
  onBranch,
  onRuns,
  onInterpreter,
}: {
  snapshot: GitSnapshot | null;
  running: number;
  path?: string | null;
  interpreter?: Interpreter;
  /** An environment task (creating or installing) is running for this folder. */
  preparing: boolean;
  onBranch(): void;
  onRuns(): void;
  /** Absent for read-only folders. */
  onInterpreter?: () => void;
}) {
  const extension = path?.includes('.') ? path.split('.').at(-1)!.toLowerCase() : '';
  const language = languages[extension];
  // VS Code's wording: "3.11.9 ('.venv')", the environment folder after the version.
  const environment = interpreter?.prefix
    ? displayPath(interpreter.prefix).split(/[\\/]/).filter(Boolean).at(-1)
    : undefined;
  const label = interpreter
    ? `${interpreter.version}${interpreter.manager !== 'system' && environment ? ` ('${environment}')` : ''}`
    : t('选择解释器');
  return (
    <footer className="sf-ide-status" aria-label={t('状态栏')}>
      {snapshot?.repository ? (
        <Button
          variant="ghost"
          className="sf-ide-status-item"
          title={t('源代码管理')}
          onClick={onBranch}
        >
          <GitBranch size={12} />
          {(snapshot.branch ?? snapshot.head?.slice(0, 8) ?? '') +
            (snapshot.changes.length ? '*' : '')}
        </Button>
      ) : null}
      {running ? (
        <Button variant="ghost" className="sf-ide-status-item" onClick={onRuns}>
          <Play size={12} />
          {t('{count} 个运行中', { count: running })}
        </Button>
      ) : null}
      <span className="spacer" />
      {language ? <span className="sf-ide-status-item">{language}</span> : null}
      <Button
        variant="ghost"
        className="sf-ide-status-item"
        title={interpreter ? displayPath(interpreter.executable) : t('选择 Python 解释器')}
        aria-label={preparing ? t('正在准备环境…') : t('Python 解释器：{name}', { name: label })}
        disabled={!onInterpreter}
        onClick={onInterpreter}
      >
        {preparing ? <LoaderCircle size={12} className="sf-ai-spinner" /> : <Box size={12} />}
        {preparing ? t('正在准备环境…') : label}
      </Button>
    </footer>
  );
}
