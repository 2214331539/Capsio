import { createStore } from 'zustand/vanilla';
import { toast } from '../../components/feedback';
import { t } from '../../i18n';

/** Something the assistant finished while nobody was watching: shown in the notification
 *  centre and once as a toast, inside the app only. */
export type AssistantNotice = {
  key: string;
  projectId: string;
  conversationId: string;
  title: string;
  kind: 'done' | 'complete' | 'blocked' | 'budget';
  at: string;
};

export const assistantNotices = createStore<{
  items: AssistantNotice[];
  /** The project whose assistant is on screen; its finished turns need no notice. */
  watching: string | null;
}>(() => ({ items: [], watching: null }));

export const openConversationEvent = 'scientify-open-conversation';

export function watchAssistant(projectId: string | null) {
  if (assistantNotices.getState().watching !== projectId)
    assistantNotices.setState({ watching: projectId });
}

export function openConversation(projectId: string, conversationId: string) {
  window.dispatchEvent(
    new CustomEvent(openConversationEvent, { detail: { projectId, conversationId } }),
  );
}

export function noticeText(item: Pick<AssistantNotice, 'kind' | 'title'>) {
  const title = item.title || t('新对话');
  if (item.kind === 'complete') return t('后台目标完成：{title}', { title });
  if (item.kind === 'blocked') return t('AI 需要你处理：{title}', { title });
  if (item.kind === 'budget') return t('后台目标用完了预算：{title}', { title });
  return t('AI 完成了：{title}', { title });
}

export function noticeAssistant(notice: Omit<AssistantNotice, 'key' | 'at'>) {
  const { items, watching } = assistantNotices.getState();
  // The assistant on screen shows it already.
  if (watching === notice.projectId) return;
  const key = `${notice.projectId}:${notice.conversationId}`;
  const item: AssistantNotice = { ...notice, key, at: new Date().toISOString() };
  assistantNotices.setState({
    items: [item, ...items.filter((entry) => entry.key !== key)].slice(0, 20),
  });
  toast(noticeText(item), {
    tone: notice.kind === 'done' || notice.kind === 'complete' ? 'success' : 'info',
    action: {
      label: t('查看'),
      run: () => {
        dismissAssistantNotice(key);
        openConversation(notice.projectId, notice.conversationId);
      },
    },
  });
}

export function dismissAssistantNotice(key: string) {
  const { items } = assistantNotices.getState();
  if (items.some((entry) => entry.key === key))
    assistantNotices.setState({ items: items.filter((entry) => entry.key !== key) });
}
