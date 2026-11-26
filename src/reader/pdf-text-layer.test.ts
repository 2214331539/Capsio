import { afterAll, beforeAll, expect, it } from 'vitest';
import { installStreamIteration } from '../platform/stream-iteration';

// A one-page PDF with real text, the offsets in its cross-reference table computed.
function pdfWith(text: string) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length + 30} >>\nstream\nBT /F1 18 Tf 36 72 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

// WebKit before Safari 27 cannot iterate a ReadableStream with `for await`.
const prototype = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
const native = [Symbol.asyncIterator, 'values'].map(
  (key) => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const,
);
beforeAll(() => {
  for (const [key] of native) delete prototype[key];
});
afterAll(() => {
  for (const [key, descriptor] of native)
    if (descriptor) Object.defineProperty(prototype, key, descriptor);
});

it('reads a page’s text for the text layer where streams are not async iterable', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Run the worker's code in this thread, as pdf.js does without a Worker.
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import(
    // @ts-expect-error pdf.js ships no type declarations for its worker module.
    'pdfjs-dist/legacy/build/pdf.worker.mjs'
  );
  const task = pdfjs.getDocument({ data: pdfWith('Selectable PDF text') });
  try {
    const page = await (await task.promise).getPage(1);
    // As in such a WebKit: the page has text, but pdf.js cannot read it.
    await expect(page.getTextContent()).rejects.toThrow(TypeError);
    expect(installStreamIteration()).toBe(true);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join('');
    expect(text).toBe('Selectable PDF text');
  } finally {
    await task.destroy();
  }
});

it('cancels the stream when a loop stops early', async () => {
  installStreamIteration();
  let cancelled = false;
  const stream = new ReadableStream<number>({
    pull: (controller) => controller.enqueue(1),
    cancel: () => {
      cancelled = true;
    },
  });
  for await (const value of stream as unknown as AsyncIterable<number>) {
    expect(value).toBe(1);
    break;
  }
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});
