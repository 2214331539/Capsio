import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Recommendations } from './Recommendations';
import type {
  BriefEvent,
  Radar,
  Recommendation,
  Recommendations as View,
} from '../../platform/radar';
import { briefNotices, noticeBrief } from '../../features/recommendations/briefs';

const openBrowserSource = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../platform/browser-pane', () => ({ openBrowserSource }));

const paper = (id: string, state: Recommendation['state'] = null): Recommendation => ({
  id,
  kind: 'paper',
  also: [],
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

/** The recommendation being read, on the right. */
const reading = (title: string) => screen.findByRole('article', { name: title });

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  briefNotices.setState({ items: [] });
});

it('says why there is nothing yet, and shows a brief as soon as it is made', async () => {
  const { engine, brief } = fakeEngine({
    state: 'preparing',
    day: null,
    items: [],
    later: [],
    highlights: [],
  });
  render(<Recommendations projectId="p" onOpenPaper={() => {}} onAsk={() => {}} engine={engine} />);
  expect(await screen.findByText('正在为这个项目准备推荐，第一次需要几分钟。')).toBeTruthy();
  engine.view.mockResolvedValue({
    state: 'ready',
    day: '2026-11-25',
    items: [paper('1')],
    later: [],
    highlights: [],
  });
  brief({ projectId: 'other', day: '2026-11-25', count: 3 });
  expect(engine.view).toHaveBeenCalledTimes(1);
  brief({ projectId: 'p', day: '2026-11-25', count: 1 });
  const article = await reading('中文标题 1');
  expect(within(article).getByText('Original 1')).toBeTruthy();
  expect(article.textContent).toContain('A, B, C 等 · arXiv · 2026-11-24');
  expect(within(article).getByText('和文献库里的 A-MEM 相关')).toBeTruthy();
  expect(within(article).getByText('做了什么')).toBeTruthy();
});

it('opening the page settles its notice', async () => {
  noticeBrief({ projectId: 'p', day: '2026-11-25', count: 2 });
  noticeBrief({ projectId: 'q', day: '2026-11-25', count: 1 });
  const { engine } = fakeEngine({
    state: 'ready',
    day: '2026-11-25',
    items: [paper('1')],
    later: [],
    highlights: [],
  });
  render(<Recommendations projectId="p" onOpenPaper={() => {}} onAsk={() => {}} engine={engine} />);
  await reading('中文标题 1');
  expect(briefNotices.getState().items.map((item) => item.projectId)).toEqual(['q']);
});

it('reads one at a time: adds, keeps for later, dismisses and moves on', async () => {
  const opened = vi.fn();
  const asked = vi.fn();
  const { engine } = fakeEngine({
    state: 'ready',
    day: '2026-11-25',
    items: [paper('1'), paper('2'), paper('3')],
    later: [],
    highlights: [],
  });
  render(<Recommendations projectId="p" onOpenPaper={opened} onAsk={asked} engine={engine} />);
  // The first one is open to read; the list shows every one.
  let article = await reading('中文标题 1');
  const list = screen.getByRole('navigation', { name: '推荐列表' });
  expect(within(list).getAllByRole('button')).toHaveLength(3);

  fireEvent.click(within(article).getByRole('button', { name: '加入文献库' }));
  await waitFor(() => expect(engine.save).toHaveBeenCalledWith('p', '1'));
  expect(await within(article).findByRole('button', { name: '已加入文献库' })).toBeTruthy();
  expect(within(list).getByText('已加入')).toBeTruthy();

  // J moves to the next one, K back.
  fireEvent.keyDown(article, { key: 'j' });
  article = await reading('中文标题 2');
  fireEvent.click(within(article).getByRole('button', { name: '稍后读' }));
  expect(engine.feedback).toHaveBeenCalledWith('p', '2', 'later', { undo: false });
  expect(within(article).getByRole('button', { name: '已稍后读' })).toBeTruthy();
  fireEvent.click(within(article).getByRole('button', { name: '问 AI' }));
  expect(asked).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));
  fireEvent.keyDown(article, { key: 'k' });
  await reading('中文标题 1');

  // Typing in a field is not a move.
  const field = document.createElement('input');
  screen.getByRole('region', { name: '推荐' }).append(field);
  fireEvent.keyDown(field, { key: 'j' });
  await reading('中文标题 1');
  field.remove();

  fireEvent.click(within(list).getByText('中文标题 3'));
  article = await reading('中文标题 3');
  fireEvent.click(within(article).getByRole('button', { name: '不感兴趣' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '不相关' }));
  expect(engine.feedback).toHaveBeenCalledWith('p', '3', 'dismissed', { reason: 'unrelated' });
  await waitFor(() => expect(screen.queryByText('中文标题 3')).toBeNull());
  // Reading goes on with a neighbour.
  article = await reading('中文标题 2');

  fireEvent.click(within(article).getByRole('button', { name: '打开原文' }));
  expect(engine.feedback).toHaveBeenCalledWith('p', '2', 'opened');
  expect(openBrowserSource).toHaveBeenCalledWith('p', 'https://arxiv.org/abs/2');
});

it('opens at the recommendation a notice was about', async () => {
  const { engine } = fakeEngine({
    state: 'ready',
    day: '2026-11-25',
    items: [paper('1'), paper('2'), paper('3')],
    later: [],
    highlights: [],
  });
  render(
    <Recommendations
      projectId="p"
      focus="3"
      onOpenPaper={() => {}}
      onAsk={() => {}}
      engine={engine}
    />,
  );
  expect(await reading('中文标题 3')).toBeTruthy();
  const current = screen
    .getByRole('navigation', { name: '推荐列表' })
    .querySelector('[aria-current="true"]');
  expect(current?.textContent).toContain('中文标题 3');
});

it('a paper without an open PDF opens its page instead', async () => {
  const { engine } = fakeEngine({
    state: 'ready',
    day: '2026-11-25',
    items: [paper('1')],
    later: [],
    highlights: [],
  });
  engine.save.mockResolvedValue({ kind: 'link', url: 'https://doi.org/10.1/x' } as never);
  render(<Recommendations projectId="p" onOpenPaper={() => {}} onAsk={() => {}} engine={engine} />);
  fireEvent.click(await screen.findByRole('button', { name: '加入文献库' }));
  await waitFor(() =>
    expect(openBrowserSource).toHaveBeenCalledWith('p', 'https://doi.org/10.1/x'),
  );
  expect(screen.getByRole('button', { name: '加入文献库' })).toBeTruthy();
});

it('shows updates beside papers, with their other sources, and filters between them', async () => {
  const update: Recommendation = {
    ...paper('n'),
    kind: 'news',
    title: '新模型发布',
    originalTitle: 'A new model ships',
    authors: ['Reporter'],
    venue: 'OpenAI',
    pdfUrl: null,
    url: 'https://openai.com/news/a',
    also: [{ source: 'The Verge', url: 'https://theverge.com/a' }],
  };
  const { engine } = fakeEngine({
    state: 'ready',
    day: '2026-11-25',
    items: [paper('1'), update],
    later: [],
    highlights: [],
  });
  render(<Recommendations projectId="p" onOpenPaper={() => {}} onAsk={() => {}} engine={engine} />);
  await screen.findByText('新模型发布');
  expect(screen.getByText('新闻')).toBeTruthy();
  expect(screen.getByText('OpenAI · 2026-11-24')).toBeTruthy();
  fireEvent.click(screen.getByText('新模型发布'));
  const article = await reading('新模型发布');
  // An update has no PDF to add to the library.
  expect(within(article).queryByRole('button', { name: '加入文献库' })).toBeNull();
  fireEvent.click(within(article).getByRole('button', { name: 'The Verge' }));
  expect(openBrowserSource).toHaveBeenCalledWith('p', 'https://theverge.com/a');

  fireEvent.click(screen.getByRole('button', { name: '动态' }));
  expect(screen.queryByText('中文标题 1')).toBeNull();
  expect(screen.getAllByText('新模型发布').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: '论文' }));
  expect(await reading('中文标题 1')).toBeTruthy();
  expect(screen.queryByText('新模型发布')).toBeNull();
});

it('shows the field highlights above the project recommendations', async () => {
  const highlight: Recommendation = {
    ...paper('h'),
    kind: 'news',
    title: '新模型发布',
    venue: 'OpenAI',
    pdfUrl: null,
    also: [
      { source: 'The Verge', url: 'https://theverge.com/h' },
      { source: 'TechCrunch', url: 'https://techcrunch.com/h' },
    ],
  };
  const { engine } = fakeEngine({
    state: 'preparing',
    day: null,
    items: [],
    later: [],
    highlights: [highlight],
  });
  render(<Recommendations projectId="p" onOpenPaper={() => {}} onAsk={() => {}} engine={engine} />);
  const section = await screen.findByRole('region', { name: '领域要闻' });
  expect(section.textContent).toContain('新模型发布');
  expect((await reading('新模型发布')).textContent).toContain('另有 2 个来源：');
  // The project's own state is still told.
  expect(screen.getByText('正在为这个项目准备推荐，第一次需要几分钟。')).toBeTruthy();
});
