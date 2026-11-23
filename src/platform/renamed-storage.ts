// Capsio was called Scientify. On Windows the page profile moves along with the
// data folder, so its saved layout, reading positions and preferences carry
// over once under the new names; tabs that pointed at scientify: pages follow.
const DONE = 'capsio.renamed';

export function adoptRenamedStorage(storage: Storage = localStorage) {
  try {
    if (storage.getItem(DONE)) return;
    for (const key of Object.keys(storage)) {
      if (!key.startsWith('scientify.')) continue;
      const renamed = `capsio.${key.slice('scientify.'.length)}`;
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(renamed) === null)
        storage.setItem(renamed, value.replace(/scientify:/g, 'capsio:'));
    }
    storage.setItem(DONE, '1');
  } catch {
    /* A full or blocked storage starts with fresh page state. */
  }
}

// Runs on import, before any module reads its saved state.
if (typeof localStorage !== 'undefined') adoptRenamedStorage();
