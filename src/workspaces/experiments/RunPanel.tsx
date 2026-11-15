import { Button } from '../../components/primitives';
import { t } from '../../i18n';
import { ExecutionPanel } from './ExecutionPanel';
import { statusLabel } from './status';
import type { Execution } from './runtime';

/** The panel's Run tab: each run on the left, its output on the right. */
export function RunPanel({
  runs,
  active,
  onActive,
}: {
  runs: Execution[];
  active?: Execution;
  onActive(id: string): void;
}) {
  if (!runs.length) return <p className="sf-ide-empty">{t('尚无运行')}</p>;
  return (
    <div className="sf-run-panel">
      <nav aria-label={t('运行')}>
        {runs.slice(0, 50).map((run) => (
          <Button
            key={run.id}
            variant="ghost"
            aria-current={run.id === active?.id || undefined}
            title={`${statusLabel(run.status)} · ${run.id.slice(0, 8)}`}
            onClick={() => onActive(run.id)}
          >
            <span className="sf-status-dot" data-status={run.status} aria-hidden="true" />
            <span>{run.name}</span>
          </Button>
        ))}
      </nav>
      <div className="sf-run-panel-output">
        <ExecutionPanel run={active} tab="logs" />
      </div>
    </div>
  );
}
