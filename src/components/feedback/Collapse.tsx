import type { ReactNode } from 'react';
import './feedback.css';

/** Opens and closes its content with a height transition. The content stays mounted, so state
 *  inside it survives; while closed it is inert and hidden from assistive technology. */
export function Collapse({
  open,
  children,
  className = '',
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`sf-collapse ${className}`.trim()}
      data-open={open}
      inert={!open}
      aria-hidden={!open || undefined}
    >
      <div className="sf-collapse-inner">{children}</div>
    </div>
  );
}

/** Keeps every state's label stacked in one place so the button never changes width; the active
 *  one fades and springs in. `state` names a key of `labels`. */
export function StateLabel({
  state,
  labels,
}: {
  state: string;
  labels: Record<string, ReactNode>;
}) {
  return (
    <span className="sf-state-label">
      {Object.entries(labels).map(([key, label]) => (
        <span
          key={key}
          data-on={key === state || undefined}
          aria-hidden={key !== state || undefined}
        >
          {label}
        </span>
      ))}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="sf-spinner" role={label ? 'img' : undefined} aria-label={label} />;
}

/** Placeholder lines while the first content loads. */
export function Skeleton({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={`sf-skeleton ${className}`.trim()} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} style={{ width: `${index === lines - 1 ? 60 : 100 - index * 7}%` }} />
      ))}
    </div>
  );
}
