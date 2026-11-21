import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from '../../components/primitives';
import { t } from '../../i18n';
import { easing, motion, reducedMotion } from '../../platform/motion';
import type { PdfSpot } from './synctex';

GlobalWorkerOptions.workerSrc = workerUrl;

type Size = { width: number; height: number };

/** A copy of what the canvas shows now, laid over it, to fade away once the new page is drawn. */
function ghostOf(canvas: HTMLCanvasElement, host: HTMLElement | null) {
  if (reducedMotion() || !host || !canvas.width || typeof canvas.animate !== 'function')
    return null;
  const copy = window.document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext('2d')?.drawImage(canvas, 0, 0);
  copy.setAttribute('aria-hidden', 'true');
  copy.className = 'sf-pdf-ghost';
  host.append(copy);
  return {
    fadeOut: () => {
      const done = () => copy.remove();
      copy
        .animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: motion.content,
          easing: easing.standard,
        })
        .addEventListener('finish', done);
      // Left at full opacity until it finishes, so it covers the swap.
      copy.style.opacity = '0';
    },
  };
}

function Page({
  document,
  number,
  size,
  scale,
}: {
  document: PDFDocumentProxy;
  number: number;
  size: Size;
  scale: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const shown = useRef<PDFDocumentProxy | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !canvas.current) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<void> } | undefined;
    void document.getPage(number).then((page) => {
      if (cancelled || !canvas.current) return;
      const viewport = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Drawn off screen, then swapped in whole: resizing a canvas clears it, which flashes white.
      const buffer = window.document.createElement('canvas');
      buffer.width = Math.floor(viewport.width * dpr);
      buffer.height = Math.floor(viewport.height * dpr);
      task = page.render({
        canvas: buffer,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      });
      task.promise
        .then(() => {
          const target = canvas.current;
          if (cancelled || !target) return;
          const fade = shown.current !== null && shown.current !== document;
          const ghost = fade ? ghostOf(target, host.current) : null;
          target.width = buffer.width;
          target.height = buffer.height;
          target.getContext('2d')?.drawImage(buffer, 0, 0);
          shown.current = document;
          ghost?.fadeOut();
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [document, number, scale, visible]);
  return (
    <div
      ref={host}
      className="sf-pdf-page"
      data-page={number}
      style={{ width: size.width * scale, height: size.height * scale }}
    >
      <canvas ref={canvas} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

/**
 * The compiled PDF, continuous like Overleaf's preview. A new build replaces the document in
 * place and keeps the reading position; double-clicking asks for the source line there.
 */
export function PdfPreview({
  data,
  highlight,
  onLocate,
}: {
  data: Uint8Array | null;
  highlight: (PdfSpot & { at: number }) | null;
  onLocate(page: number, x: number, y: number): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [width, setWidth] = useState(600);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const keep = useRef<number | null>(null);
  const loaded = useRef<ReturnType<typeof getDocument> | null>(null);
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!data) return;
    let stale = false;
    const base = import.meta.env.BASE_URL + 'pdfjs/';
    const task = getDocument({
      data: data.slice(),
      useSystemFonts: true,
      cMapUrl: base + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: base + 'standard_fonts/',
      wasmUrl: base + 'wasm/',
      iccUrl: base + 'iccs/',
    });
    void task.promise
      .then(async (pdf) => {
        const next: Size[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const viewport = (await pdf.getPage(n)).getViewport({ scale: 1 });
          next.push({ width: viewport.width, height: viewport.height });
        }
        if (stale) return void task.destroy();
        const element = scroller.current;
        if (element && element.scrollHeight > element.clientHeight)
          keep.current = element.scrollTop / element.scrollHeight;
        setError('');
        setSizes(next);
        setDocument(pdf);
        // The previous build stays on screen until this one is ready, then is released.
        void loaded.current?.destroy();
        loaded.current = task;
      })
      .catch((reason: unknown) => {
        if (!stale) setError(String((reason as Error)?.message ?? reason));
      });
    return () => {
      stale = true;
    };
  }, [data]);
  useEffect(() => () => void loaded.current?.destroy(), []);
  const widest = Math.max(1, ...sizes.map((size) => size.width));
  const scale = zoom === 'fit' ? Math.max(0.3, Math.min(3, (width - 32) / widest)) : zoom;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && keep.current !== null) {
      element.scrollTop = keep.current * element.scrollHeight;
      keep.current = null;
    }
  }, [document, sizes]);
  const top = (number: number) => {
    let offset = 16;
    for (let n = 1; n < number; n++) offset += (sizes[n - 1]?.height ?? 0) * scale + 16;
    return offset;
  };
  useEffect(() => {
    const element = scroller.current;
    if (!highlight || !element || !sizes[highlight.page - 1]) return;
    element.scrollTo({
      top: Math.max(0, top(highlight.page) + highlight.y * scale - element.clientHeight / 3),
      behavior: 'smooth',
    });
  }, [highlight?.at]);
  const scrolled = () => {
    const element = scroller.current;
    if (!element || !sizes.length) return;
    let number = 1;
    while (number < sizes.length && top(number + 1) <= element.scrollTop + element.clientHeight / 3)
      number++;
    setPage(number);
  };
  const step = (delta: number) =>
    setZoom(Math.round(Math.max(0.3, Math.min(3, scale + delta)) * 10) / 10);
  return (
    <section className="sf-pdf-preview" aria-label={t('PDF 预览')}>
      <div className="sf-pdf-preview-bar">
        <span>{document ? `${page} / ${document.numPages}` : ''}</span>
        <span className="spacer" />
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('缩小')}
          tooltip={t('缩小')}
          onClick={() => step(-0.1)}
        >
          <ZoomOut size={14} />
        </Button>
        <span className="sf-pdf-zoom">{Math.round(scale * 100)}%</span>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('放大')}
          tooltip={t('放大')}
          onClick={() => step(0.1)}
        >
          <ZoomIn size={14} />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('适应宽度')}
          tooltip={t('适应宽度')}
          aria-pressed={zoom === 'fit'}
          onClick={() => setZoom('fit')}
        >
          <Maximize size={14} />
        </Button>
      </div>
      <div className="sf-pdf-scroll" ref={scroller} onScroll={scrolled}>
        {error ? (
          <p className="sf-ide-empty" role="alert">
            {error}
          </p>
        ) : null}
        {document
          ? sizes.map((size, index) => (
              <div
                key={index}
                className="sf-pdf-slot"
                onDoubleClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onLocate(
                    index + 1,
                    (event.clientX - rect.left) / scale,
                    (event.clientY - rect.top) / scale,
                  );
                }}
              >
                <Page document={document} number={index + 1} size={size} scale={scale} />
                {highlight && highlight.page === index + 1 ? (
                  <div
                    key={highlight.at}
                    className="sf-pdf-flash"
                    style={{
                      left: highlight.x * scale - 4,
                      top: highlight.y * scale - 3,
                      width: highlight.width * scale + 8,
                      height: highlight.height * scale + 6,
                    }}
                  />
                ) : null}
              </div>
            ))
          : null}
      </div>
    </section>
  );
}
