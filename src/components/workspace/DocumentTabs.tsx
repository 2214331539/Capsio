import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { ChevronDown, FileText, Plus, X } from 'lucide-react';
import { Button } from '../primitives';
import { Menu, type MenuAnchor } from '../primitives/Menu';
import { t } from '../../i18n';
import { easing, motion, reducedMotion } from '../../platform/motion';
import './document-tabs.css';

type Tab = { id: string; title: string; pinned?: boolean; icon?: ReactNode };

/** Pixels a tab must travel before a press becomes a drag. */
const DRAG_START = 5;

export function DocumentTabs({
  tabs,
  activeId,
  panelId,
  onSelect,
  onClose,
  onNew,
  onReorder,
  label,
  newLabel,
  onContextMenu,
}: {
  /** A pinned tab (the library itself) has no close button and stays in front. */
  tabs: Tab[];
  activeId: string | null;
  panelId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew?: () => void;
  /** Dragging a tab to a new place; receives every tab id in the new order. */
  onReorder?: (ids: string[]) => void;
  label?: string;
  newLabel?: string;
  onContextMenu?: (id: string, position: { x: number; y: number }) => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const cards = useRef(new Map<string, HTMLDivElement>());
  const cardRefs = useRef(new Map<string, (node: HTMLDivElement | null) => () => void>());
  const lastLeft = useRef(new Map<string, number>());
  const latest = useRef(tabs);
  latest.current = tabs;
  const mounted = useRef(false);
  const strip = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);
  const add = useRef<HTMLButtonElement>(null);
  const dragged = useRef(false);
  const reordered = useRef(false);
  const [drag, setDrag] = useState<{ id: string; dx: number; to: number } | null>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });
  const [allMenu, setAllMenu] = useState<MenuAnchor | null>(null);

  useEffect(() => {
    const selected = activeId ? refs.current.get(activeId) : undefined;
    selected?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (focusPending.current) {
      (selected ?? add.current)?.focus({ preventScroll: true });
      focusPending.current = false;
    }
  }, [activeId, tabs.length]);

  // New tabs rise in; tabs that moved (one closed or was dragged) slide to their new place.
  // A new tab fades in, and after a drag the tabs slide to their new places. Closing a tab, or
  // a title changing its width, moves the others at once: sliding then reads as shaking.
  useLayoutEffect(() => {
    const animate = mounted.current && !reducedMotion();
    for (const [id, card] of cards.current) {
      const left = card.offsetLeft;
      const before = lastLeft.current.get(id);
      if (animate && typeof card.animate === 'function') {
        if (before === undefined)
          card.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: motion.overlayFade,
            easing: easing.enter,
          });
        else if (reordered.current && before !== left)
          card.animate([{ translate: `${before - left}px 0` }, { translate: '0 0' }], {
            duration: motion.content,
            easing: easing.enter,
          });
      }
      lastLeft.current.set(id, left);
    }
    for (const id of [...lastLeft.current.keys()])
      if (!cards.current.has(id)) lastLeft.current.delete(id);
    reordered.current = false;
    mounted.current = true;
  });

  // Fade the edges and offer a list of every tab once they no longer fit.
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () =>
      setOverflow({
        start: element.scrollLeft > 1,
        end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      });
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [tabs.length]);

  /** Stable per tab, so the cleanup runs only when that tab leaves: it fades out in place. */
  /** Stable per tab, so a re-render does not detach and attach it again. */
  function cardRef(id: string) {
    let callback = cardRefs.current.get(id);
    if (!callback) {
      callback = (node) => {
        if (node) cards.current.set(id, node);
        return () => {
          if (cards.current.get(id) === node) cards.current.delete(id);
          if (!latest.current.some((tab) => tab.id === id)) cardRefs.current.delete(id);
        };
      };
      cardRefs.current.set(id, callback);
    }
    return callback;
  }
  function startDrag(event: ReactPointerEvent<HTMLDivElement>, tab: Tab, index: number) {
    if (!onReorder || tab.pinned || event.button !== 0) return;
    if ((event.target as Element).closest('[data-tab-close]')) return;
    const startX = event.clientX;
    const target = event.currentTarget;
    const pointer = event.pointerId;
    const first = tabs.findIndex((item) => !item.pinned);
    let active = false;
    let to = index;
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      if (!active && Math.abs(dx) < DRAG_START) return;
      if (!active) {
        active = true;
        target.setPointerCapture(pointer);
      }
      // The drop slot is the gap whose neighbours straddle the pointer.
      to = index;
      for (const [position, item] of tabs.entries()) {
        const card = cards.current.get(item.id);
        if (!card || item.id === tab.id) continue;
        const box = card.getBoundingClientRect();
        const middle = box.left + box.width / 2;
        if (position < index && moveEvent.clientX < middle) to = Math.min(to, position);
        if (position > index && moveEvent.clientX > middle) to = Math.max(to, position);
      }
      to = Math.max(first, to);
      setDrag({ id: tab.id, dx, to });
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      if (target.hasPointerCapture(pointer)) target.releasePointerCapture(pointer);
      setDrag(null);
      if (!active) return;
      dragged.current = true;
      if (to !== index) {
        reordered.current = true;
        const ids = tabs.map((item) => item.id).filter((id) => id !== tab.id);
        ids.splice(to, 0, tab.id);
        onReorder(ids);
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  const dropIndex = drag ? tabs.findIndex((item) => item.id === drag.id) : -1;
  return (
    <div
      className="document-tabs"
      ref={strip}
      data-overflow-start={overflow.start || undefined}
      data-overflow-end={overflow.end || undefined}
    >
      <div
        className="document-tab-list"
        ref={list}
        role="tablist"
        aria-label={label ?? t('文献标签页')}
      >
        {tabs.map((tab, index) => (
          <div
            className={`document-tab ${tab.id === activeId ? 'is-active' : ''}`}
            key={tab.id}
            ref={cardRef(tab.id)}
            data-dragging={drag?.id === tab.id || undefined}
            data-drop={
              drag && drag.to !== dropIndex && index === drag.to
                ? drag.to < dropIndex
                  ? 'before'
                  : 'after'
                : undefined
            }
            style={drag?.id === tab.id ? { translate: `${drag.dx}px 0` } : undefined}
            onPointerDown={(event) => startDrag(event, tab, index)}
            onAuxClick={(event) => {
              // Middle click closes, as in browsers.
              if (event.button !== 1 || tab.pinned) return;
              event.preventDefault();
              onClose(tab.id);
            }}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
          >
            <Button
              variant="ghost"
              role="tab"
              title={tab.title}
              aria-selected={tab.id === activeId}
              aria-controls={panelId}
              tabIndex={tab.id === activeId ? 0 : -1}
              data-press="off"
              ref={(node) => {
                if (node) refs.current.set(tab.id, node);
                else refs.current.delete(tab.id);
              }}
              onClick={() => {
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                onSelect(tab.id);
              }}
              onContextMenu={
                onContextMenu
                  ? (event) => {
                      event.preventDefault();
                      onContextMenu(tab.id, { x: event.clientX, y: event.clientY });
                    }
                  : undefined
              }
              onKeyDown={(event) => {
                if (
                  onContextMenu &&
                  (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                ) {
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  onContextMenu(tab.id, { x: bounds.left, y: bounds.bottom });
                  return;
                }
                let target: string | undefined;
                if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length]?.id;
                else if (event.key === 'ArrowLeft')
                  target = tabs[(index + tabs.length - 1) % tabs.length]?.id;
                else if (event.key === 'Home') target = tabs[0]?.id;
                else if (event.key === 'End') target = tabs.at(-1)?.id;
                else if (event.key === 'Delete' && !tab.pinned) {
                  event.preventDefault();
                  focusPending.current = true;
                  onClose(tab.id);
                  return;
                }
                if (target) {
                  event.preventDefault();
                  refs.current.get(target)?.focus();
                  onSelect(target);
                }
              }}
            >
              {tab.icon ?? <FileText size={14} />}
              <span>{tab.title}</span>
            </Button>
            {tab.pinned ? null : (
              <Button
                variant="ghost"
                iconOnly
                tabIndex={-1}
                data-tab-close
                aria-label={t('关闭 {name}', { name: tab.title })}
                onClick={() => {
                  focusPending.current = true;
                  onClose(tab.id);
                }}
              >
                <X size={12} />
              </Button>
            )}
          </div>
        ))}
      </div>
      {overflow.start || overflow.end ? (
        <Button
          variant="ghost"
          iconOnly
          className="document-tab-all"
          aria-label={t('全部标签页')}
          aria-haspopup="menu"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setAllMenu({ x: box.left, y: box.bottom + 4, trigger: event.currentTarget });
          }}
        >
          <ChevronDown size={15} />
        </Button>
      ) : null}
      {onNew && (
        <Button
          variant="ghost"
          iconOnly
          className="document-tab-add"
          ref={add}
          aria-label={newLabel ?? t('新建文献标签页')}
          onClick={() => {
            focusPending.current = true;
            onNew();
          }}
        >
          <Plus size={15} />
        </Button>
      )}
      <Menu anchor={allMenu} label={t('全部标签页')} onClose={() => setAllMenu(null)}>
        {tabs.map((tab) => (
          <Button
            key={tab.id}
            role="menuitemradio"
            aria-checked={tab.id === activeId}
            variant="ghost"
            onClick={() => onSelect(tab.id)}
          >
            {tab.icon ?? <FileText />}
            <span className="document-tab-menu-title">{tab.title}</span>
          </Button>
        ))}
      </Menu>
    </div>
  );
}
