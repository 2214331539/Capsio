import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ShieldAlert, TerminalSquare, FileWarning, GitBranch } from 'lucide-react';
import { Button } from '../primitives';
import { Collapse } from '../feedback';
import { t } from '../../i18n';
import {
  HOST_APPROVAL_METHODS,
  type ApprovalDecision,
  type ApprovalRequest,
} from '../../platform/agent';
import './approval-card.css';

/** Fields the engine sends with an approval prompt. They are optional in the
 * transport, so every one of them has to survive being absent. */
type ApprovalParams = {
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  grantRoot?: string | null;
  /** Note approvals: a new note or a change to an existing one. */
  action?: string | null;
};

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : '');

function describe(event: ApprovalRequest): {
  icon: typeof ShieldAlert;
  title: string;
  detail: string;
  target: string;
} {
  const params = (event.params ?? {}) as ApprovalParams;
  if (event.method === 'scientify/git/requestApproval') {
    return {
      icon: GitBranch,
      title: t('请求执行 Git 操作'),
      detail: text(params.reason),
      target: text(params.command),
    };
  }
  if (event.method === 'scientify/docs/requestApproval') {
    return {
      icon: FileWarning,
      title: params.action === 'create' ? t('请求新建文档') : t('请求修改文档'),
      detail: text(params.reason),
      target: text(params.command),
    };
  }
  if (event.method === 'scientify/notes/requestApproval') {
    return {
      icon: FileWarning,
      title: params.action === 'create' ? t('请求新建笔记') : t('请求修改笔记'),
      detail: text(params.reason),
      target: text(params.command),
    };
  }
  if (event.method === 'item/commandExecution/requestApproval') {
    return {
      icon: TerminalSquare,
      title: t('请求执行命令'),
      detail: text(params.reason),
      target: text(params.command),
    };
  }
  if (event.method === 'item/fileChange/requestApproval') {
    return {
      icon: FileWarning,
      title: t('请求修改文件'),
      detail: text(params.reason),
      // `grantRoot` asks for write access under a root, not a single file.
      target: text(params.grantRoot) ? t('目录：{path}', { path: text(params.grantRoot) }) : '',
    };
  }
  return {
    icon: ShieldAlert,
    title: t('请求提升权限'),
    detail: '',
    target: '',
  };
}

/** What the card says once the decision is made. */
function resultText(decision: ApprovalDecision) {
  switch (decision) {
    case 'accept':
      return t('已允许');
    case 'acceptForSession':
      return t('本会话已允许');
    case 'acceptAlways':
      return t('已设为以后都允许');
    case 'decline':
      return t('已拒绝');
    case 'cancel':
      return t('已中止任务');
    case 'grantPermissions':
      return t('已允许权限');
    case 'denyPermissions':
      return t('已拒绝权限');
  }
}
/** How long a decision may stay unanswered before the card takes the buttons back. */
const SETTLE = 300;

/**
 * An inline prompt for one engine approval request.
 *
 * The engine decides when to ask (approval policy plus sandbox); the host owns
 * presentation and the answer. Answering is mandatory — an ignored request
 * blocks the turn, so the card never renders without a way to reply.
 *
 * It is emphasised once when it appears. With the card itself focused, Enter allows and
 * Esc refuses; the composer keeps its own Enter. After the decision the card folds into one
 * line saying what was chosen (`resolved` is set by the owner once the request is gone).
 */
export function ApprovalCard({
  event,
  busy = false,
  resolved = false,
  onDecide,
}: {
  event: ApprovalRequest;
  busy?: boolean;
  /** The engine has the answer; the request is no longer pending. */
  resolved?: boolean;
  onDecide(decision: ApprovalDecision): void | Promise<void>;
}) {
  const { icon: Icon, title, detail, target } = describe(event);
  // `item/permissions/requestApproval` answers with a permission profile rather
  // than a decision, so it uses the dedicated grant/deny response shape below.
  const permissionRequest = event.method === 'item/permissions/requestApproval';
  // The command prefix Codex suggests allowing from now on, e.g. `pip install`.
  const proposed = (event.params as { proposedExecpolicyAmendment?: unknown } | undefined)
    ?.proposedExecpolicyAmendment;
  const alwaysPattern =
    event.method === 'item/commandExecution/requestApproval' &&
    Array.isArray(proposed) &&
    proposed.length
      ? proposed.join(' ')
      : '';
  const [chosen, setChosen] = useState<ApprovalDecision | null>(null);
  const resolvedNow = useRef(resolved);
  resolvedNow.current = resolved;
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(settle.current), []);
  // Answered somewhere else and gone: nothing to show.
  if (resolved && !chosen) return null;
  const done = resolved && !!chosen;
  const locked = busy || !!chosen;
  function decide(decision: ApprovalDecision) {
    if (locked) return;
    setChosen(decision);
    // The owner may decline to pass it on (unsaved files); then the buttons come back.
    void Promise.resolve(onDecide(decision))
      .catch(() => {})
      .then(() => {
        clearTimeout(settle.current);
        settle.current = setTimeout(() => {
          if (!resolvedNow.current) setChosen(null);
        }, SETTLE);
      });
  }
  function keys(keyEvent: KeyboardEvent<HTMLElement>) {
    if (done || locked) return;
    if (keyEvent.key === 'Escape') {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      decide(permissionRequest ? 'denyPermissions' : 'decline');
    } else if (keyEvent.key === 'Enter' && keyEvent.target === keyEvent.currentTarget) {
      // Only the card itself: a focused button keeps its own Enter.
      keyEvent.preventDefault();
      decide(permissionRequest ? 'grantPermissions' : 'accept');
    }
  }
  return (
    <article
      className="sf-approval"
      role="group"
      aria-label={title}
      data-method={event.method}
      data-state={done ? 'done' : 'pending'}
      tabIndex={done ? -1 : 0}
      onKeyDown={keys}
    >
      <header className="sf-approval-head">
        <Icon size={15} aria-hidden="true" />
        <strong>{title}</strong>
        {chosen ? (
          <span className="sf-approval-result" role="status">
            {resultText(chosen)}
          </span>
        ) : null}
      </header>
      <Collapse open={!done}>
        {target ? <pre className="sf-approval-target">{target}</pre> : null}
        {detail ? <p className="sf-approval-detail">{detail}</p> : null}
        {permissionRequest ? (
          <div className="sf-approval-actions">
            <Button
              variant="primary"
              size="sm"
              type="button"
              disabled={locked}
              onClick={() => decide('grantPermissions')}
            >
              {t('允许本次权限')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={locked}
              onClick={() => decide('denyPermissions')}
            >
              {t('拒绝权限')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={locked}
              onClick={() => decide('cancel')}
            >
              {t('中止任务')}
            </Button>
          </div>
        ) : (
          <div className="sf-approval-actions">
            <Button
              variant="primary"
              size="sm"
              type="button"
              disabled={locked}
              onClick={() => decide('accept')}
            >
              {t('允许')}
            </Button>
            {!HOST_APPROVAL_METHODS.has(event.method) && (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={locked}
                onClick={() => decide('acceptForSession')}
              >
                {t('本会话允许')}
              </Button>
            )}
            {alwaysPattern ? (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={locked}
                title={t('以后遇到 {pattern} 开头的命令都直接运行', { pattern: alwaysPattern })}
                onClick={() => decide('acceptAlways')}
              >
                {t('以后都允许')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={locked}
              onClick={() => decide('decline')}
            >
              {t('拒绝')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={locked}
              // Distinct from decline: cancelling aborts the turn instead of
              // refusing this one action.
              onClick={() => decide('cancel')}
            >
              {t('中止任务')}
            </Button>
          </div>
        )}
        <p className="sf-approval-hint" aria-hidden="true">
          {t('Enter 允许 · Esc 拒绝')}
        </p>
      </Collapse>
    </article>
  );
}
