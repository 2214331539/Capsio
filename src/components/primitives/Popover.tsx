import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './primitives.css';

/** A panel anchored under (or above) its trigger; Escape and outside clicks close it. */
export function Popover({
  anchor,
  label,
  width = 320,
  align = 'start',
  children,
  onClose,
}: {
  anchor: HTMLElement | null;
  label: string;
  width?: number;
  align?: 'start' | 'end';
  children: ReactNode;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!anchor || !panel) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const wanted = align === 'end' ? rect.right - panel.offsetWidth : rect.left;
      const left = Math.max(8, Math.min(wanted, innerWidth - panel.offsetWidth - 8));
      panel.style.left = `${left}px`;
      const below = rect.bottom + 6;
      const above = below + panel.offsetHeight > innerHeight - 8;
      panel.style.top = above
        ? `${Math.max(8, rect.top - 6 - panel.offsetHeight)}px`
        : `${below}px`;
      // Grow out of the trigger.
      const originX = Math.max(0, Math.min(panel.offsetWidth, rect.left + rect.width / 2 - left));
      panel.style.transformOrigin = `${originX}px ${above ? '100%' : '0'}`;
    };
    place();
    panel
      .querySelector<HTMLElement>('button:not(:disabled), input')
      ?.focus({ preventScroll: true });
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [anchor, align]);
  useEffect(() => {
    if (!anchor) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      // Menus and confirmations opened from the panel belong to it.
      if ((target as Element).closest?.('[data-nested-menu], dialog[open]')) return;
      if (!ref.current?.contains(target) && !anchor.contains(target)) close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close.current();
      anchor.focus({ preventScroll: true });
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', close.current);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', close.current);
    };
  }, [anchor]);
  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className="sf-popover sf-panel-popover"
      role="dialog"
      aria-label={label}
      data-native-overlay="true"
      style={{ width }}
    >
      {children}
    </div>,
    document.body,
  );
}
