/**
 * Moving between a paper and its translation. The translation keeps the paper's pages, so a
 * place in one is the same page and point in the other, as SyncTeX moves between a LaTeX
 * source and its PDF.
 */

/** A page (from 1) and a point on it, in PDF points. */
export type PdfSpot = { page: number; point: [number, number] };

const spotEvent = 'capsio-pdf-spot';
/** A place asked of a reader that is still opening; it shows once the reader is ready. */
const pending = new Map<string, { spot: PdfSpot; at: number }>();
const WAIT = 15_000;

/** Shows a place in the reader of `assetId`, now or as soon as it opens. */
export function showPdfSpot(assetId: string, spot: PdfSpot) {
  pending.set(assetId, { spot, at: Date.now() });
  window.dispatchEvent(new CustomEvent(spotEvent, { detail: { assetId } }));
}

/** The place waiting for this reader, taken so it shows once. */
export function takePdfSpot(assetId: string): PdfSpot | null {
  const waiting = pending.get(assetId);
  pending.delete(assetId);
  return waiting && Date.now() - waiting.at < WAIT ? waiting.spot : null;
}

/** Calls `show` with each place asked of this reader. Returns the way to stop. */
export function listenPdfSpot(assetId: string, show: (spot: PdfSpot) => void) {
  const handler = (event: Event) => {
    if ((event as CustomEvent<{ assetId: string }>).detail?.assetId !== assetId) return;
    const spot = takePdfSpot(assetId);
    if (spot) show(spot);
  };
  window.addEventListener(spotEvent, handler);
  return () => window.removeEventListener(spotEvent, handler);
}

/** The asset id a paper's translation is read under. */
export const translationAsset = (paperId: string, fingerprint: string) =>
  `translation:${paperId}:${fingerprint}`;
