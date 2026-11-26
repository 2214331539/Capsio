import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// The default pdf.js build calls Promise.try, Map.getOrInsertComputed and other JavaScript
// that WebKit only has from Safari 26.2. On macOS the app draws with the system WebKit, so on
// older systems the worker fails and PDFs stay blank. The legacy build carries polyfills.
// Types may still come from 'pdfjs-dist'; the legacy declarations re-export them.
const modern = /(?:from|import|import\()\s*'pdfjs-dist(?:\/(?:build|web)\/[^']*\.mjs[^']*)?'/;

const sources = readdirSync('src', { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => [file.replaceAll('\\', '/'), readFileSync(join('src', file), 'utf8')] as const);

it('loads pdf.js code only from the legacy build', () => {
  const offending = sources.flatMap(([file, text]) =>
    text
      .replaceAll(/import\s+type\s[^;]*;/g, '')
      .split('\n')
      .filter((line) => modern.test(line))
      .map((line) => `${file}: ${line.trim()}`),
  );
  expect(offending).toEqual([]);
});
