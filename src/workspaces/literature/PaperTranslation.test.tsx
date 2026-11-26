import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PaperTranslation } from './PaperTranslation';
import type { TranslationEvent, TranslationStatus, Translator } from '../../platform/translator';

vi.mock('../../reader/PdfReader', () => ({
  default: ({ title }: { title: string }) => <div aria-label="Translated PDF">{title}</div>,
}));
const confirmed = vi.hoisted(() => ({ answer: true }));
vi.mock('../../components/prompts', () => ({
  confirmAction: vi.fn(async () => confirmed.answer),
}));

const paper = { id: 'a', path: 'a.pdf', notePath: 'a.notes.md', fingerprint: 'f'.repeat(64) };

function fakeEngine(initial: TranslationStatus) {
  let emit: ((event: TranslationEvent) => void) | undefined;
  const engine = {
    status: vi.fn(async () => initial),
    open: vi.fn(async () => initial),
    retranslate: vi.fn(async (): Promise<TranslationStatus> => ({ state: 'waiting', progress: 0 })),
    resume: vi.fn(async (): Promise<TranslationStatus> => ({ state: 'waiting', progress: 0 })),
    save: vi.fn(async () => true),
    reveal: vi.fn(async () => {}),
    pdf: vi.fn(async () => new Uint8Array()),
    events: vi.fn(async (callback: (event: TranslationEvent) => void) => {
      emit = callback;
      return () => {};
    }),
  };
  const send = (status: TranslationStatus) =>
    act(() => emit?.({ projectId: 'p', fingerprint: paper.fingerprint, status }));
  return { engine: engine as Translator & typeof engine, send };
}

afterEach(() => cleanup());

it('opening the pane asks for the paper, shows progress quietly, then the translation', async () => {
  const { engine, send } = fakeEngine({ state: 'waiting', progress: 0 });
  render(<PaperTranslation projectId="p" paper={paper} title="Paper" engine={engine} />);
  expect(await screen.findByText('准备翻译…')).toBeTruthy();
  expect(engine.open).toHaveBeenCalledWith('p', 'a');
  // Nothing to press: no start, stop, retry or settings.
  expect(screen.queryByRole('button')).toBeNull();
  send({ state: 'translating', progress: 42.4 });
  expect(screen.getByText('正在翻译 42%')).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: '翻译进度' }).getAttribute('aria-valuenow')).toBe(
    '42',
  );
  send({ state: 'done', progress: 100 });
  expect(await screen.findByLabelText('Translated PDF')).toBeTruthy();
  expect(screen.getByText('Paper（译文）')).toBeTruthy();
});

it('shows a translation that is already there', async () => {
  const { engine } = fakeEngine({ state: 'done', progress: 100 });
  render(<PaperTranslation projectId="p" paper={paper} title="Paper" engine={engine} />);
  expect(await screen.findByLabelText('Translated PDF')).toBeTruthy();
});

it('a finished translation can be done again once confirmed', async () => {
  const { engine } = fakeEngine({ state: 'done', progress: 100 });
  render(<PaperTranslation projectId="p" paper={paper} title="Paper" engine={engine} />);
  const again = await screen.findByRole('button', { name: '重新翻译' });
  confirmed.answer = false;
  await act(async () => fireEvent.click(again));
  expect(engine.retranslate).not.toHaveBeenCalled();
  confirmed.answer = true;
  await act(async () => fireEvent.click(again));
  expect(engine.retranslate).toHaveBeenCalledWith('p', 'a');
  expect(await screen.findByText('准备翻译…')).toBeTruthy();
});

it('says where a waiting paper stands: its place in the queue, a pause and why, or a failure', async () => {
  const { engine, send } = fakeEngine({ state: 'waiting', progress: 0, ahead: 2 });
  render(<PaperTranslation projectId="p" paper={paper} title="Paper" engine={engine} />);
  expect(await screen.findByText('排队中，前面还有 2 篇')).toBeTruthy();
  send({ state: 'paused', progress: 0, reason: '模型服务繁忙', resumeIn: 125 });
  expect(screen.getByText('翻译暂停：模型服务繁忙')).toBeTruthy();
  expect(screen.getByText('3 分钟后自动重试')).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '立即重试' })));
  expect(engine.resume).toHaveBeenCalledWith('p', 'a');
  send({ state: 'failed', progress: 0, reason: '试了 3 次都没有翻译成功。' });
  expect(screen.getByText('这篇论文没能翻译出来')).toBeTruthy();
  expect(screen.getByRole('button', { name: '重新翻译' })).toBeTruthy();
});

it('exports a finished translation or shows where it is', async () => {
  const { engine } = fakeEngine({ state: 'done', progress: 100 });
  render(<PaperTranslation projectId="p" paper={paper} title="Paper" engine={engine} />);
  const save = await screen.findByRole('button', { name: '导出 PDF' });
  await act(async () => fireEvent.click(save));
  expect(engine.save).toHaveBeenCalledWith('p', 'a', 'Paper（译文）');
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: '在文件管理器中显示' })),
  );
  expect(engine.reveal).toHaveBeenCalledWith('p', 'a');
});
