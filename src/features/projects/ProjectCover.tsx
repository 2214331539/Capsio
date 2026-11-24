import type { CSSProperties, ReactNode } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { t } from '../../i18n';
import { toneOf } from './model';
import './project-library.css';

/** The folder that stands for a project in the project center: a back with its tab, papers
 *  inside, and a front with a paper label that stays readable on any colour. */
export function ProjectCoverArt({
  name,
  field,
  question,
  color,
  archived,
}: {
  name: string;
  field?: string;
  question?: string;
  color: string;
  archived?: boolean;
}) {
  return (
    <span
      className={`project-cover-art${archived ? ' archived' : ''}`}
      style={{ '--cover': toneOf(color) } as CSSProperties}
    >
      <span className="project-folder-back" aria-hidden="true" />
      <span className="project-folder-paper" aria-hidden="true" />
      <span className="project-folder-front">
        <span className="project-folder-label">
          <span className="project-cover-field">{archived ? t('已归档') : field}</span>
          <strong className="project-cover-name">{name}</strong>
          {question ? <span className="project-cover-question">{question}</span> : null}
        </span>
      </span>
    </span>
  );
}

export function MiniCover({ color }: { color: string }) {
  return (
    <span
      className="project-mini-cover"
      style={{ '--cover': toneOf(color) } as CSSProperties}
      aria-hidden="true"
    />
  );
}

/** Page title and the page's actions. */
export function CenterHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="center-header">
      <h1>{title}</h1>
      <div className="center-header-actions">{children}</div>
    </header>
  );
}

export function CenterEmpty({
  icon,
  title,
  children,
  actions,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <EmptyState className="center-empty" icon={icon} title={title} actions={actions}>
      {children}
    </EmptyState>
  );
}
