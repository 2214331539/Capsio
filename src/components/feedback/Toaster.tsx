import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { t } from '../../i18n';
import { usePreferences } from '../../i18n/preferences';
import { motion } from '../../platform/motion';
import './feedback.css';

export type ToastTone = 'info' | 'success' | 'error';
export type ToastAction = { label: string; run(): void | Promise<void> };
export type ToastOptions = {
  tone?: ToastTone;
  action?: ToastAction;
  /** Milliseconds; errors and progress stay until dismissed or finished. */
  duration?: number;
  /** 0–1 shows a bar; undefined shows none. */
  progress?: number;
};
type Toast = Required<Pick<ToastOptions, 'tone'>> &
  ToastOptions & { id: number; message: string; leaving?: boolean };

const AUTO = 4000;
const WITH_ACTION = 6000;
const MAX = 4;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
let mounted = false;

function emit(next: Toast[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

function mount() {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const container = document.createElement('div');
  container.className = 'sf-toaster-root';
  document.body.append(container);
  createRoot(container).render(<ToastStack />);
}

/** One short message at the bottom of the window. Success and info leave on their own; errors
 *  stay until closed. Returns an id for `updateToast` / `dismissToast`. */
export function toast(message: string, options: ToastOptions = {}) {
  mount();
  const id = nextId++;
  const item: Toast = { id, message, tone: options.tone ?? 'info', ...options };
  emit([...toasts.filter((entry) => !entry.leaving), item].slice(-MAX));
  return id;
}

/** The action already happened; the toast offers to take it back. */
export function toastUndo(
  message: string,
  undo: () => void | Promise<void>,
  options?: ToastOptions,
) {
  return toast(message, { tone: 'success', action: { label: t('撤销'), run: undo }, ...options });
}

export function toastError(message: string, retry?: () => void | Promise<void>) {
  return toast(message, {
    tone: 'error',
    action: retry ? { label: t('重试'), run: retry } : undefined,
  });
}

export function updateToast(id: number, patch: Partial<ToastOptions> & { message?: string }) {
  if (!toasts.some((entry) => entry.id === id)) return;
  emit(toasts.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
}

export function dismissToast(id: number) {
  if (!toasts.some((entry) => entry.id === id && !entry.leaving)) return;
  emit(toasts.map((entry) => (entry.id === id ? { ...entry, leaving: true } : entry)));
  setTimeout(() => emit(toasts.filter((entry) => entry.id !== id)), motion.exit);
}

/** Test helper: forget every toast immediately. */
export function clearToasts() {
  emit([]);
}

export function useToasts() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
    () => toasts,
  );
}

function lifetime(item: Toast) {
  if (item.duration !== undefined) return item.duration;
  if (item.tone === 'error' || item.progress !== undefined) return Infinity;
  return item.action ? WITH_ACTION : AUTO;
}

function ToastView({ item }: { item: Toast }) {
  const paused = useRef(false);
  const remaining = useRef(lifetime(item));
  useEffect(() => {
    remaining.current = lifetime(item);
  }, [item.duration, item.tone, item.progress, item.action]);
  useEffect(() => {
    if (item.leaving || !Number.isFinite(remaining.current)) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (!paused.current) remaining.current -= now - last;
      last = now;
      if (remaining.current <= 0) dismissToast(item.id);
    }, 100);
    return () => clearInterval(timer);
  }, [item.id, item.leaving, item.duration, item.tone, item.progress]);
  const Icon = item.tone === 'error' ? CircleAlert : item.tone === 'success' ? CircleCheck : null;
  return (
    <div
      className="sf-toast"
      data-tone={item.tone}
      data-leaving={item.leaving || undefined}
      role={item.tone === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => (paused.current = true)}
      onPointerLeave={() => (paused.current = false)}
    >
      {Icon ? <Icon className="sf-toast-icon" aria-hidden="true" /> : null}
      <span className="sf-toast-message">{item.message}</span>
      {item.action ? (
        <button
          type="button"
          className="sf-toast-action"
          data-press
          onClick={() => {
            const action = item.action!;
            dismissToast(item.id);
            void Promise.resolve()
              .then(() => action.run())
              .catch((reason) => toastError(String(reason?.message ?? reason)));
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      {item.tone === 'error' || !Number.isFinite(lifetime(item)) ? (
        <button
          type="button"
          className="sf-toast-close"
          aria-label={t('关闭')}
          data-press
          onClick={() => dismissToast(item.id)}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
      {item.progress !== undefined ? (
        <span className="sf-toast-progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, item.progress))})` }} />
        </span>
      ) : null}
    </div>
  );
}

function ToastStack() {
  usePreferences();
  const items = useToasts();
  return (
    <div className="sf-toaster" aria-live="polite">
      {items.map((item) => (
        <ToastView key={item.id} item={item} />
      ))}
    </div>
  );
}
