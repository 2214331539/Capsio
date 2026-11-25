import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** A recommended paper as the recommendations page shows it. */
export type RecommendedPaper = {
  id: string;
  /** The model's Chinese title. */
  title: string;
  originalTitle: string;
  summary: string;
  reason: string;
  authors: string[];
  venue: string | null;
  published: string | null;
  url: string;
  pdfUrl: string | null;
  state: 'saved' | 'dismissed' | 'later' | null;
};

/** A project's recommendations: the latest brief, or why there is none yet. */
export type Recommendations = {
  state: 'off' | 'needsPapers' | 'noModel' | 'preparing' | 'ready';
  day: string | null;
  items: RecommendedPaper[];
  later: RecommendedPaper[];
};

export type RecommendationAction = 'opened' | 'later' | 'dismissed' | 'saved';

export type SaveOutcome = { kind: 'added'; paperId: string } | { kind: 'link'; url: string };

/** A new daily brief, made in the background. */
export type BriefEvent = { projectId: string; day: string; count: number };

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('推荐只能在 Capsio 桌面应用中使用。'));
  return invoke<T>(name, args);
}

/**
 * Recommendations work in the background by themselves; the app only says which project is
 * open, shows the results and passes on what the user does with them.
 */
export const radar = {
  visit: (projectId: string) =>
    isTauri() ? command<void>('radar_visit', { projectId }) : Promise.resolve(),
  view: (projectId: string) => command<Recommendations>('radar_view', { projectId }),
  feedback: (
    projectId: string,
    workId: string,
    action: RecommendationAction,
    options: { reason?: string; undo?: boolean } = {},
  ) => command<void>('radar_feedback', { projectId, workId, action, ...options }),
  save: (projectId: string, workId: string) =>
    command<SaveOutcome>('radar_save', { projectId, workId }),
  clear: () => command<void>('radar_clear'),
  briefs: (callback: (event: BriefEvent) => void) =>
    isTauri()
      ? listen<BriefEvent>('radar-brief', (event) => callback(event.payload))
      : Promise.resolve(() => {}),
};
export type Radar = typeof radar;
