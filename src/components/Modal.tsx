import { t } from '../i18n';
import { Button } from './primitives';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { browserLayout } from '../platform/browser-pane';
import { easing, motion, reducedMotion, scale } from '../platform/motion';

/** A closing dialog leaves an inert copy in its place that fades out; the real dialog and its
 *  state are already gone, so nothing waits for the animation. */
function leaveGhost(dialog: HTMLDialogElement) {
  if (
    !dialog.open ||
    !dialog.isConnected ||
    reducedMotion() ||
    typeof dialog.animate !== 'function'
  )
    return;
  const rect = dialog.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const layer = document.createElement('div');
  layer.className = 'sf-dialog-ghost';
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  layer.style.background = getComputedStyle(dialog, '::backdrop').backgroundColor;
  const ghost = dialog.cloneNode(true) as HTMLDialogElement;
  ghost.removeAttribute('data-native-overlay');
  for (const node of ghost.querySelectorAll('[id]')) node.removeAttribute('id');
  for (const node of ghost.querySelectorAll('iframe, video, audio, object, embed')) node.remove();
  Object.assign(ghost.style, {
    position: 'fixed',
    inset: 'auto',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    boxSizing: 'border-box',
    animation: 'none',
  });
  layer.append(ghost);
  document.body.append(layer);
  const timing = { duration: motion.exit, easing: easing.exit, fill: 'forwards' as const };
  layer.animate([{ opacity: 1 }, { opacity: 0 }], timing);
  void ghost
    .animate([{ scale: '1' }, { scale: String(scale.popFrom) }], timing)
    .finished.catch(() => {})
    .then(() => layer.remove());
}

export function Modal({
  title,
  children,
  onClose,
  busy = false,
  dirty = false,
  className,
  sidebar,
  heading,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
  dirty?: boolean;
  className?: string;
  sidebar?: ReactNode;
  heading?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  // Capture before descendants' React autoFocus effects can change activeElement.
  const [trigger] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [discard, setDiscard] = useState(false);
  const backdropPressed = useRef(false);
  // Layout cleanup runs while the dialog is still in the document.
  useLayoutEffect(() => {
    const dialog = ref.current!;
    return () => leaveGhost(dialog);
  }, []);
  useEffect(() => {
    const dialog = ref.current!;
    let active = true;
    const show = () => {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('[data-autofocus="true"]')?.focus({ preventScroll: true });
    };
    if (isTauri())
      void browserLayout({ op: 'hideAll' })
        .catch(() => {})
        .then(() => {
          if (active) show();
        });
    else show();
    return () => {
      active = false;
      dialog.close();
      // Nested discard dialogs must be closed before restoring the outer trigger.
      queueMicrotask(() => {
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      });
    };
  }, []);
  function close() {
    if (busy || discard) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  const content = (
    <>
      <header className="dialog-heading">
        <h2 id={id}>{heading ?? title}</h2>
        <Button
          type="button"
          variant="ghost"
          iconOnly
          className="icon-button"
          onClick={close}
          disabled={busy}
          aria-label={t('关闭弹窗')}
        >
          ×
        </Button>
      </header>
      {children}
    </>
  );
  return (
    <>
      <dialog
        data-native-overlay="true"
        ref={ref}
        className={className}
        aria-label={sidebar ? title : undefined}
        aria-labelledby={sidebar ? undefined : id}
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          backdropPressed.current =
            event.target === event.currentTarget &&
            (event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget && backdropPressed.current) close();
          backdropPressed.current = false;
        }}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        {sidebar ? (
          <>
            {sidebar}
            <div className="modal-main">{content}</div>
          </>
        ) : (
          content
        )}
      </dialog>
      {discard && (
        <Modal title={t('确认操作')} onClose={() => setDiscard(false)} busy={busy}>
          <div className="form-grid">
            <p>{t('放弃尚未保存的修改？')}</p>
            <footer className="dialog-footer">
              <Button type="button" autoFocus disabled={busy} onClick={() => setDiscard(false)}>
                {t('取消')}
              </Button>
              <Button type="button" variant="primary" disabled={busy} onClick={onClose}>
                {t('确认')}
              </Button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}
