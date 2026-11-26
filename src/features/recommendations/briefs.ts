import { createStore } from 'zustand/vanilla';
import { toast } from '../../components/feedback';
import { t } from '../../i18n';
import { radar, type AlertEvent, type BriefEvent } from '../../platform/radar';

/** Daily briefs made in the background and not looked at yet: one per project, for the
 *  notification centre. */
export const briefNotices = createStore<{ items: BriefEvent[] }>(() => ({ items: [] }));

/** Recommendations worth telling at once and not looked at yet, newest first. */
export const alertNotices = createStore<{ items: AlertEvent[] }>(() => ({ items: [] }));

export const openRecommendationsEvent = 'capsio-open-recommendations';

export function noticeBrief(brief: BriefEvent) {
  const others = briefNotices.getState().items.filter((item) => item.projectId !== brief.projectId);
  briefNotices.setState({ items: [brief, ...others] });
}

export function dismissBrief(projectId: string) {
  const { items } = briefNotices.getState();
  if (items.some((item) => item.projectId === projectId))
    briefNotices.setState({ items: items.filter((item) => item.projectId !== projectId) });
  const alerts = alertNotices.getState().items;
  if (alerts.some((item) => item.projectId === projectId))
    alertNotices.setState({ items: alerts.filter((item) => item.projectId !== projectId) });
}

export function noticeAlert(alert: AlertEvent) {
  const others = alertNotices.getState().items.filter((item) => item.workId !== alert.workId);
  alertNotices.setState({ items: [alert, ...others] });
}

export function dismissAlert(workId: string) {
  const { items } = alertNotices.getState();
  alertNotices.setState({ items: items.filter((item) => item.workId !== workId) });
}

/** Shows a project's recommendations, `item` first when given; looking at them settles its
 *  notice. */
export function openRecommendations(projectId: string, item?: string) {
  dismissBrief(projectId);
  window.dispatchEvent(new CustomEvent(openRecommendationsEvent, { detail: { projectId, item } }));
}

/** Collects briefs and alerts as they come; an alert also shows once. Returns the way to stop. */
export function followBriefs(engine = radar): () => void {
  const stops = [
    engine.briefs(noticeBrief),
    engine.alerts((alert) => {
      noticeAlert(alert);
      toast(t('新论文提醒：{title}', { title: alert.title }), {
        action: { label: t('查看'), run: () => openRecommendations(alert.projectId, alert.workId) },
      });
    }),
  ];
  return () => stops.forEach((stop) => void stop.then((unlisten) => unlisten()));
}
