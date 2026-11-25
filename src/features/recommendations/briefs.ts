import { createStore } from 'zustand/vanilla';
import { radar, type BriefEvent } from '../../platform/radar';

/** Daily briefs made in the background and not looked at yet: one per project, for the
 *  notification centre. */
export const briefNotices = createStore<{ items: BriefEvent[] }>(() => ({ items: [] }));

export const openRecommendationsEvent = 'capsio-open-recommendations';

export function noticeBrief(brief: BriefEvent) {
  const others = briefNotices.getState().items.filter((item) => item.projectId !== brief.projectId);
  briefNotices.setState({ items: [brief, ...others] });
}

export function dismissBrief(projectId: string) {
  const { items } = briefNotices.getState();
  if (items.some((item) => item.projectId === projectId))
    briefNotices.setState({ items: items.filter((item) => item.projectId !== projectId) });
}

/** Shows a project's recommendations; looking at them settles its notice. */
export function openRecommendations(projectId: string) {
  dismissBrief(projectId);
  window.dispatchEvent(new CustomEvent(openRecommendationsEvent, { detail: { projectId } }));
}

/** Collects briefs as they are made. Returns the way to stop. */
export function followBriefs(engine = radar): () => void {
  const stop = engine.briefs(noticeBrief);
  return () => void stop.then((unlisten) => unlisten());
}
