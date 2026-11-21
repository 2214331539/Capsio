import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProgressRing, TranslationIcon, useTranslationStatus } from './ProgressRing';
import type { TranslationEvent, Translator } from '../../platform/translator';

afterEach(cleanup);

it('fills the ring with the percentage and turns it while the end is unknown', () => {
  const { rerender } = render(<ProgressRing value={42.4} label="翻译进度" />);
  const ring = screen.getByRole('progressbar', { name: '翻译进度' });
  expect(ring.getAttribute('aria-valuenow')).toBe('42');
  expect(ring.hasAttribute('data-indeterminate')).toBe(false);
  rerender(<ProgressRing label="翻译进度" />);
  expect(ring.hasAttribute('data-indeterminate')).toBe(true);
  expect(ring.hasAttribute('aria-valuenow')).toBe(false);
});

it('shows the ring on a translation tab only until the translation is done', () => {
  const { container, rerender } = render(
    <TranslationIcon status={{ state: 'translating', progress: 60 }} />,
  );
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60');
  rerender(<TranslationIcon status={{ state: 'done', progress: 100 }} />);
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(container.querySelector('.lucide-languages')).not.toBeNull();
});

it('keeps the status of papers current from the first answer and later events', async () => {
  let emit: ((event: TranslationEvent) => void) | undefined;
  const engine = {
    status: vi.fn(async () => ({ state: 'waiting' as const, progress: 0 })),
    events: vi.fn(async (callback: (event: TranslationEvent) => void) => {
      emit = callback;
      return () => {};
    }),
  } as unknown as Translator;
  const { result } = renderHook(() =>
    useTranslationStatus('p', [{ id: 'a', fingerprint: 'fa' }], engine),
  );
  await vi.waitFor(() => expect(result.current.fa).toEqual({ state: 'waiting', progress: 0 }));
  act(() =>
    emit?.({ projectId: 'p', fingerprint: 'fa', status: { state: 'translating', progress: 30 } }),
  );
  expect(result.current.fa).toEqual({ state: 'translating', progress: 30 });
  act(() =>
    emit?.({ projectId: 'other', fingerprint: 'fa', status: { state: 'done', progress: 100 } }),
  );
  expect(result.current.fa.state).toBe('translating');
});
