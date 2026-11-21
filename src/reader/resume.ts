// Reopening a paper puts you back on the page you left; the reader says so once per paper and
// session. A page jump from a note or a link also opens the reader on that page, and that is
// not a return to where you were.
const skipped = new Set<string>();
const told = new Set<string>();

/** The next open of this paper is a jump to a page, not a return. */
export function skipResumeHint(assetId: string) {
  skipped.add(assetId);
}

/** True when the reader should tell the user it returned to the last page. */
export function takeResumeHint(assetId: string) {
  const skip = skipped.delete(assetId);
  if (skip || told.has(assetId)) return false;
  told.add(assetId);
  return true;
}
