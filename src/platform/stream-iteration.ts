// `for await (const chunk of stream)` needs ReadableStream to be async iterable, which
// WebKit only is from Safari 27. pdf.js reads every page's text that way (getTextContent),
// so on macOS with an older system WebKit pages drew but had no text layer: nothing could
// be selected, searched or translated. This adds the standard behaviour where it is missing.

export function installStreamIteration(
  target: typeof ReadableStream | undefined = globalThis.ReadableStream,
) {
  if (!target || Symbol.asyncIterator in target.prototype) return false;
  async function* values(this: ReadableStream, { preventCancel = false } = {}) {
    const reader = this.getReader();
    let finished = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          return;
        }
        yield value;
      }
    } finally {
      // Leaving the loop early cancels the stream, as the standard iterator does.
      if (!finished && !preventCancel) await reader.cancel();
      reader.releaseLock();
    }
  }
  for (const key of ['values', Symbol.asyncIterator])
    Object.defineProperty(target.prototype, key, {
      value: values,
      writable: true,
      configurable: true,
    });
  return true;
}

installStreamIteration();
