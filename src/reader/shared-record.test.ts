import { expect, it, vi } from 'vitest';
import type { PaperAnnotation, PaperRecord } from '../platform/library';
import { sharedRecord } from './shared-record';

const mark = (id: string): PaperAnnotation => ({
  id,
  kind: 'highlight',
  page: 0,
  rects: [[0, 0, 1, 1]],
  text: id,
  comment: '',
  color: '#ffd400',
});

it('tells every reader of a paper what another changed, and saves in order', async () => {
  const written: PaperRecord[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const store = sharedRecord({
    load: async () => null,
    save: vi.fn(async (record: PaperRecord) => {
      // The first save is slow; the second must still land after it.
      if (!written.length) await slow;
      written.push(record);
      return record;
    }),
  });
  const original = vi.fn();
  const translation = vi.fn();
  const stop = store.subscribe!(original);
  store.subscribe!(translation);

  const first = store.save({ annotations: [mark('a')] });
  expect(translation).toHaveBeenCalledWith({ annotations: [mark('a')] });
  const second = store.save({ annotations: [mark('a'), mark('b')] });
  release();
  await Promise.all([first, second]);
  expect(written.map((record) => record.annotations?.length)).toEqual([1, 2]);

  stop();
  await store.save({ annotations: [] });
  expect(original).toHaveBeenCalledTimes(2);
  expect(translation).toHaveBeenCalledTimes(3);
});
