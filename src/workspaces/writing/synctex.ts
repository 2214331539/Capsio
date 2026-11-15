import { sourcePath } from './latex';

/** One SyncTeX record in PDF big points, measured from the page's top-left corner. */
export type SyncRecord = {
  page: number;
  tag: number;
  line: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Horizontal boxes (lines of text) rather than single points or whole blocks. */
  lineBox: boolean;
};
export type SyncData = { inputs: Map<number, string>; records: SyncRecord[] };
export type PdfSpot = { page: number; x: number; y: number; width: number; height: number };

/**
 * Reads SyncTeX text (the format pdfTeX, XeTeX and Tectonic write). Positions are scaled points
 * from the page's top-left; they are converted to PDF points with the file's unit and magnification.
 */
export function parseSynctex(text: string, root?: string): SyncData {
  const inputs = new Map<number, string>();
  const records: SyncRecord[] = [];
  let unit = 1;
  let magnification = 1000;
  let xOffset = 0;
  let yOffset = 0;
  let page = 0;
  let content = false;
  const record =
    /^([[(hvxkg$])(\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;
  for (const line of text.split('\n')) {
    if (line.startsWith('Input:')) {
      const match = /^Input:(\d+):(.*)$/.exec(line);
      if (match) inputs.set(Number(match[1]), sourcePath(match[2], root));
      continue;
    }
    if (!content) {
      const [key, value] = line.split(':');
      if (key === 'Unit') unit = Number(value) || 1;
      else if (key === 'Magnification') magnification = Number(value) || 1000;
      else if (key === 'X Offset') xOffset = Number(value) || 0;
      else if (key === 'Y Offset') yOffset = Number(value) || 0;
      else if (key === 'Content') content = true;
      continue;
    }
    if (line.startsWith('{')) {
      page = Number(line.slice(1)) || page + 1;
      continue;
    }
    const match = record.exec(line);
    if (!match || !page) continue;
    const scale = ((unit * magnification) / 1000 / 65536) * (72 / 72.27);
    const kind = match[1];
    const h = (Number(match[4]) + xOffset) * scale;
    const v = (Number(match[5]) + yOffset) * scale;
    const boxed = '[(hv'.includes(kind) && match[7] !== undefined;
    const width = boxed ? Number(match[6]) * scale : 0;
    const above = boxed ? Number(match[7]) * scale : 0;
    const below = boxed ? Number(match[8]) * scale : 0;
    records.push({
      page,
      tag: Number(match[2]),
      line: Number(match[3]),
      x: h,
      y: v - above,
      width: Math.max(0, width),
      height: Math.max(0, above + below),
      lineBox: kind === '(' || kind === 'h',
    });
  }
  return { inputs, records };
}

const same = (input: string, file: string) => {
  const a = input.toLowerCase();
  const b = file.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return (
    a === b ||
    a.endsWith('/' + b) ||
    a === b.replace(/\.tex$/, '') ||
    a.endsWith('/' + b.replace(/\.tex$/, ''))
  );
};

/** Where a source line ends up in the PDF: the boxes typeset from it, or the next line that has any. */
export function forwardSearch(data: SyncData, file: string, line: number): PdfSpot | null {
  const tags = new Set([...data.inputs].filter(([, path]) => same(path, file)).map(([tag]) => tag));
  const own = data.records.filter((record) => tags.has(record.tag) && record.line > 0);
  if (!own.length) return null;
  const exact = own.filter((record) => record.line === line);
  const after = own.filter((record) => record.line > line);
  const nearest = exact.length
    ? exact
    : after.length
      ? after.filter((record) => record.line === Math.min(...after.map((r) => r.line)))
      : own.filter((record) => record.line === Math.max(...own.map((r) => r.line)));
  const first = Math.min(...nearest.map((record) => record.page));
  const onPage = nearest.filter((record) => record.page === first);
  const boxes = onPage.filter((record) => record.lineBox && record.height > 0);
  const chosen = boxes.length ? boxes : onPage;
  const left = Math.min(...chosen.map((r) => r.x));
  const top = Math.min(...chosen.map((r) => r.y));
  const right = Math.max(...chosen.map((r) => r.x + r.width));
  const bottom = Math.max(...chosen.map((r) => r.y + r.height));
  return {
    page: first,
    x: left,
    y: top - (bottom === top ? 8 : 0),
    width: Math.max(right - left, 24),
    height: Math.max(bottom - top, 10),
  };
}

/** The source line behind a point on a PDF page: the smallest line box around it, else the nearest record. */
export function backwardSearch(
  data: SyncData,
  page: number,
  x: number,
  y: number,
): { file: string; line: number } | null {
  const onPage = data.records.filter(
    (record) => record.page === page && record.line > 0 && data.inputs.has(record.tag),
  );
  if (!onPage.length) return null;
  const inside = onPage
    .filter(
      (record) =>
        record.lineBox &&
        x >= record.x &&
        x <= record.x + record.width &&
        y >= record.y &&
        y <= record.y + record.height,
    )
    .sort((a, b) => a.width * a.height - b.width * b.height);
  const distance = (record: SyncRecord) => {
    const dx = Math.max(record.x - x, 0, x - (record.x + record.width));
    const dy = Math.max(record.y - y, 0, y - (record.y + record.height));
    return dx * dx + dy * dy * 4;
  };
  const best = inside[0] ?? [...onPage].sort((a, b) => distance(a) - distance(b))[0];
  return { file: data.inputs.get(best.tag)!, line: best.line };
}
