import type { PaperRecord } from '../platform/library';
import type { RecordStore } from './PdfReader';

/**
 * One paper's record for every reader showing it: the paper and its translation. A highlight
 * made in one shows in the other at once, and saves go one after another, so neither reader
 * writes over what the other just added.
 */
export function sharedRecord(store: Pick<RecordStore, 'load' | 'save'>): RecordStore {
  const listeners = new Set<(record: PaperRecord) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    load: () => store.load(),
    save(record) {
      listeners.forEach((listener) => listener(record));
      const saved = queue.then(() => store.save(record));
      queue = saved.catch(() => {});
      return saved;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
