import { afterEach, expect, it, vi } from 'vitest';
import { listenPdfSpot, showPdfSpot, takePdfSpot, translationAsset } from './pdf-sync';

afterEach(() => vi.useRealTimers());

it('shows a place in the reader it is meant for, once', () => {
  const original = vi.fn();
  const translation = vi.fn();
  const stops = [
    listenPdfSpot('p', original),
    listenPdfSpot(translationAsset('p', 'f'), translation),
  ];
  showPdfSpot('p', { page: 3, point: [72, 500] });
  expect(original).toHaveBeenCalledWith({ page: 3, point: [72, 500] });
  expect(translation).not.toHaveBeenCalled();
  expect(takePdfSpot('p')).toBeNull();
  stops.forEach((stop) => stop());
});

it('keeps a place for a reader still opening, but not for long', () => {
  vi.useFakeTimers();
  showPdfSpot('later', { page: 2, point: [0, 100] });
  expect(takePdfSpot('later')).toEqual({ page: 2, point: [0, 100] });
  showPdfSpot('stale', { page: 2, point: [0, 100] });
  vi.advanceTimersByTime(20_000);
  expect(takePdfSpot('stale')).toBeNull();
});
