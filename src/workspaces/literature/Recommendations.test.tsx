import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Recommendations } from './Recommendations';
import type {
  BriefEvent,
  Radar,
  RecommendedPaper,
  Recommendations as View,
} from '../../platform/radar';
import { briefNotices, noticeBrief } from '../../features/recommendations/briefs';

const openBrowserSource = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../platform/browser-pane', () => ({ openBrowserSource }));

const paper = (id: string, state: RecommendedPaper['state'] = null): RecommendedPaper => ({
  id,
  title: `中文标题 ${id}`,
  originalTitle: `Original ${id}`,
  summary: '做了什么',
  reason: '和文献库里的 A-MEM 相关',
  authors: ['A', 'B', 'C', 'D'],
  venue: 'arXiv',
  published: '2026-11-24',
  url: `https://arxiv.org/abs/${id}`,
  pdfUrl: `https://arxiv.org/pdf/${id}`,
  state,
});

function fakeEngine(view: View) {
  let emit: ((event: BriefEvent) => void) | undefined;
  const engine = {
    visit: vi.fn(async () => {}),
    view: vi.fn(async () => view),
    feedback: vi.fn(async () => {}),
    save: vi.fn(async () => ({ kind: 'added' as const, paperId: 'paper-1' })),
    clear: vi.fn(async () => {}),
    briefs: vi.fn(async (callback: (event: BriefEvent) => void) => {
      emit = callback;
      return () => {};
    }),
  };
  const brief = (event: BriefEvent) => act(() => emit?.(event));
  return { engine: engine as Radar & typeof engine, brief };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  briefNotices.setState({ items: [] });
});

it('says why there is nothing yet, and shows a brief as soon as it is made', async () => {
  const { engine, brief } = fakeEngine({ state: 'preparing', day: null, items: [], later: [] });
  render(<Recommendations projectId="p" onOpenPaper={() => {}} onAsk={() => {}} engine={engine} />);
  expect(await screen.findByText('正在为这个项目准备推荐，第一次需要几分钟。')).toBeTruthy();
  engine.view.mockResolvedValue({ state: 'ready', day: '2026-11-25', items: [paper('1')], later: [] });
  brief({ projectId: 'other', day: '2026-11-25', count: 3 });
  expect(engine.view).toHaveBeenCalledTimes(1);
  brief({ projectId: 'p', day: '2026-11-25', count: 1 });
  expect(await screen.findByText('中文标题 1')).toBeTruthy();
  expect(screen.getByText('Original 1')).toBeTruthy();
  expect(screen.getByText('A, B, C 等 · arXiv · 2026-11-24')).toBeTruthy();
  expect(screen.getByText('和文献库里的 A-MEM 相关')).toBeTruthy();
});

it('opening the page settles its notice', async () => {
  noticeBrief({ projectId: 'p', day: '2026-11-25', count: 2 });
  noticeBrief({ projectId: 'q', day: '2026-11-25', count: 1 });
  const { engine } = fakeEngine({ state: 'ready', day: '2026-11-25', items: [paper('1')], later: [] });
  render(<Recommendations projectId="p" onOpenPaper={() => {}} onAsk={() => {}} engine={engine} />);
  await screen.findByText('中文标题 1');
  expect(briefNotices.getState().items.map((item) => item.projectId)).toEqual(['q']);
});

it('adds a paper to the library, keeps one for later and dismisses one with a reason', async () => {
  const opened = vi.fn();
  const asked = vi.fn();
  const { engine } = fakeEngine({
    state: 'ready',
    day: '2026-11-25',
    items: [paper('1'), paper('2'), paper('3')],
    later: [],
  });
  render(<Recommendations projectId="p" onOpenPaper={opened} onAsk={asked} engine={engine} />);
  await screen.findByText('中文标题 1');

  fireEvent.click(screen.getAllByRole('button', { name: '加入文献库' })[0]);
  await waitFor(() => expect(engine.save).toHaveBeenCalledWith('p', '1'));
  expect(await screen.findByRole('button', { name: '已加入文献库' })).toBeTruthy();

  fireEvent.click(screen.getAllByRole('button', { name: '稍后读' })[1]);
  expect(engine.feedback).toHaveBeenCalledWith('p', '2', 'later', { undo: false });
  expect(screen.getByRole('button', { name: '已稍后读' })).toBeTruthy();

  fireEvent.click(screen.getAllByRole('button', { name: '不感兴趣' })[2]);
  fireEvent.click(await screen.findByRole('menuitem', { name: '不相关' }));
  expect(engine.feedback).toHaveBeenCalledWith('p', '3', 'dismissed', { reason: 'unrelated' });
  await waitFor(() => expect(screen.queryByText('中文标题 3')).toBeNull());

  fireEvent.click(screen.getByText('中文标题 1'));
  expect(engine.feedback).toHaveBeenCalledWith('p', '1', 'opened');
  expect(openBrowserSource).toHaveBeenCalledWith('p', 'https://arxiv.org/abs/1');

  fireEvent.click(screen.getAllByRole('button', { name: '问 AI' })[1]);
  expect(asked).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));
});

it('a paper without an open PDF opens its page instead', async () => {
  const { engine } = fakeEngine({ state: 'ready', day: '2026-11-25', items: [paper('1')], later: [] });
  engine.save.mockResolvedValue({ kind: 'link', url: 'https://doi.org/10.1/x' } as never);
  render(<Recommendations projectId="p" onOpenPaper={() => {}} onAsk={() => {}} engine={engine} />);
  fireEvent.click(await screen.findByRole('button', { name: '加入文献库' }));
  await waitFor(() => expect(openBrowserSource).toHaveBeenCalledWith('p', 'https://doi.org/10.1/x'));
  expect(screen.getByRole('button', { name: '加入文献库' })).toBeTruthy();
});
