import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { reportError } from '../../platform/error-reports';
import './primitives.css';

export type MenuAnchor = {
  x: number;
  /** Top edge by default; bottom edge when placement is top. */
  y: number;
  placement?: 'top' | 'bottom';
  trigger?: HTMLElement | null;
};

/** Shared pointer/keyboard menu. Exit retention is visual only; actions run immediately. */
export function Menu({
  anchor,
  label,
  children,
  onClose,
  nested = false,
}: {
  anchor: MenuAnchor | null;
  label: string;
  children: ReactNode;
  onClose(): void;
  /** Opened from inside another menu (a right-click on one of its items): using it keeps that menu open. */
  nested?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(!!anchor);
  const lastAnchor = useRef(anchor);
  const content = useRef(children);
  if (anchor) content.current = children;
  const close = useRef(onClose);
  // The item being pressed: a press that never becomes a click is reported, to find out why.
  const pressed = useRef<{ label: string; at: number } | null>(null);
  close.current = onClose;
  if (anchor) lastAnchor.current = anchor;

  useLayoutEffect(() => {
    if (anchor) {
      setPresent(true);
      return;
    }
    if (!ref.current || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setPresent(false);
      return;
    }
    const duration =
      parseFloat(getComputedStyle(ref.current).getPropertyValue('--sf-motion-exit')) || 0;
    const timer = window.setTimeout(() => setPresent(false), duration);
    return () => clearTimeout(timer);
  }, [anchor]);

  useLayoutEffect(() => {
    if (!anchor || !present || !ref.current) return;
    const menu = ref.current;
    const position = () => {
      // Constrain upward menus before measuring so long lists stay above the trigger.
      menu.style.maxHeight =
        anchor.placement === 'top' ? `${Math.max(0, Math.min(360, anchor.y - 8))}px` : '';
      // offset sizes are not affected by the entry transform.
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const left = Math.max(8, Math.min(anchor.x, innerWidth - width - 8));
      const wanted = anchor.placement === 'top' ? anchor.y - height : anchor.y;
      const top = Math.max(8, Math.min(wanted, innerHeight - height - 8));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      // Grow out of the point it was opened from.
      const originX = Math.max(0, Math.min(width, anchor.x - left));
      const originY = Math.max(0, Math.min(height, anchor.y - top));
      menu.style.transformOrigin = `${originX}px ${originY}px`;
    };
    position();
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [anchor, present]);

  useEffect(() => {
    if (!anchor) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current?.contains(target) || target?.closest?.('[data-nested-menu]')) return;
      close.current();
    };
    const dismissed = (reason: string) => () => {
      const item = pressed.current;
      if (item && Date.now() - item.at < 1000)
        reportError(
          new Error('Menu closed by window ' + reason + ' while "' + item.label + '" was pressed'),
          'menu',
        );
      close.current();
    };
    // Another program can take focus for a moment when the mouse goes down (a selection
    // translator, a screenshot tool); closing then made the menu inert and swallowed the
    // click. The menu closes only once the window has really lost focus, never mid-press.
    let blurTimer = 0;
    const blur = () => {
      const item = pressed.current;
      if (item && Date.now() - item.at < 1000)
        reportError(new Error('Window lost focus while "' + item.label + '" was pressed'), 'menu');
      window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(() => {
        if (!document.hasFocus() && !pressed.current) close.current();
      }, 300);
    };
    const focus = () => window.clearTimeout(blurTimer);
    const resize = dismissed('resize');
    const scroll = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) close.current();
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.clearTimeout(blurTimer);
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [anchor]);

  if (!present) return null;
  const restore = () => {
    const trigger = lastAnchor.current?.trigger;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  return createPortal(
    <div
      ref={ref}
      className="sf-menu sf-popover"
      role="menu"
      aria-label={label}
      data-state={anchor ? 'open' : 'closed'}
      data-placement={lastAnchor.current?.placement ?? 'bottom'}
      aria-hidden={!anchor || undefined}
      inert={!anchor}
      data-native-overlay={anchor ? 'true' : undefined}
      data-nested-menu={nested || undefined}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        const item = (event.target as HTMLElement).closest<HTMLButtonElement>(
          'button[role^="menuitem"]',
        );
        if (!item) return;
        const press = { label: (item.textContent ?? '').trim().slice(0, 40), at: Date.now() };
        pressed.current = press;
        window.setTimeout(() => {
          if (pressed.current !== press) return;
          pressed.current = null;
          reportError(new Error(`Menu item "${press.label}" was pressed but did not run`), 'menu');
        }, 1500);
      }}
      onClickCapture={(event) => {
        pressed.current = null;
        const item = (event.target as HTMLElement).closest<HTMLButtonElement>(
          'button[role^="menuitem"]',
        );
        if (item && !item.disabled) {
          restore();
          close.current();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          restore();
          close.current();
          return;
        }
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const target =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : event.key === 'ArrowDown'
                ? (index + 1) % items.length
                : event.key === 'ArrowUp'
                  ? (index + items.length - 1) % items.length
                  : -1;
        if (target >= 0) {
          event.preventDefault();
          items[target]?.focus();
        }
      }}
    >
      {content.current}
    </div>,
    lastAnchor.current?.trigger?.closest('dialog[open]') || document.body,
  );
}

export function menuAnchor(
  event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
): MenuAnchor {
  const rect = event.currentTarget.getBoundingClientRect();
  const pointer = 'clientX' in event && (event.clientX !== 0 || event.clientY !== 0);
  return {
    x: pointer ? event.clientX : rect.left,
    y: pointer ? event.clientY : rect.bottom + 4,
    trigger: event.currentTarget,
  };
}
