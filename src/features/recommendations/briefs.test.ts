import { afterEach, expect, it, vi } from 'vitest';
import type { AlertEvent, BriefEvent, Radar } from '../../platform/radar';
import { alertNotices, briefNotices, dismissAlert, dismissBrief, followBriefs } from './briefs';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../components/feedback', () => ({ toast }));

afterEach(() => {
  briefNotices.setState({ items: [] });
  alertNotices.setState({ items: [] });
  toast.mockReset();
});

function engine() {
  const emit: { brief?: (event: BriefEvent) => void; alert?: (event: AlertEvent) => void } = {};
  const fake = {
    briefs: vi.fn(async (callback: (event: BriefEvent) => void) => {
      emit.brief = callback;
      return () => {};
    }),
    alerts: vi.fn(async (callback: (event: AlertEvent) => void) => {
      emit.alert = callback;
      return () => {};
    }),
  };
  return { fake: fake as unknown as Radar, emit };
}

it('an alert shows once and waits in the notification centre until its project is looked at', () => {
  const { fake, emit } = engine();
  const stop = followBriefs(fake);
  const alert = {
    projectId: 'p',
    workId: 'w1',
    title: '新论文',
    why: '引用了你文献库里的《A-MEM》',
  };
  emit.alert?.(alert);
  emit.alert?.({ ...alert, workId: 'w2', projectId: 'q' });
  emit.brief?.({ projectId: 'p', day: '2026-11-25', count: 3 });
  expect(toast).toHaveBeenCalledTimes(2);
  expect(toast.mock.calls[0][0]).toBe('新论文提醒：新论文');
  expect(alertNotices.getState().items.map((item) => item.workId)).toEqual(['w2', 'w1']);

  dismissBrief('p');
  expect(alertNotices.getState().items.map((item) => item.workId)).toEqual(['w2']);
  expect(briefNotices.getState().items).toEqual([]);
  dismissAlert('w2');
  expect(alertNotices.getState().items).toEqual([]);
  stop();
});
