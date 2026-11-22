import { useLayoutEffect, useRef, type RefObject } from 'react';
import { easing, motion, reducedMotion } from '../../platform/motion';

const MOST_ROWS = 150;

/**
 * Rows marked `data-flip="key"` inside `container` glide from where they were to where they are
 * after a render, so reordering, staging and expanding do not jump. A row that was not there
 * before simply appears. Only `translate` moves; the layout itself is already final.
 * With `armedUntil` (a timestamp) rows only glide until then, e.g. right after a drop; at
 * other times, such as a deleted row closing its gap, they move at once.
 */
export function useFlip(container: RefObject<HTMLElement | null>, armedUntil?: RefObject<number>) {
  const last = useRef(new Map<string, number>());
  const root = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = container.current;
    if (element !== root.current) {
      root.current = element;
      last.current = new Map();
    }
    if (!element) return;
    const rows = element.querySelectorAll<HTMLElement>('[data-flip]');
    if (rows.length > MOST_ROWS) {
      last.current = new Map();
      return;
    }
    // Positions are measured inside the scrolled content, so scrolling between renders is no move.
    const origin = element.getBoundingClientRect().top - element.scrollTop;
    const next = new Map<string, number>();
    const animate =
      typeof Element !== 'undefined' &&
      typeof Element.prototype.animate === 'function' &&
      !reducedMotion() &&
      (!armedUntil || Date.now() < armedUntil.current);
    for (const row of rows) {
      const key = row.dataset.flip!;
      const top = row.getBoundingClientRect().top - origin;
      next.set(key, top);
      const before = last.current.get(key);
      if (!animate || before === undefined || Math.abs(before - top) < 1) continue;
      row.animate([{ translate: `0 ${before - top}px` }, { translate: '0 0' }], {
        duration: motion.content,
        easing: easing.enter,
      });
    }
    last.current = next;
  });
}
