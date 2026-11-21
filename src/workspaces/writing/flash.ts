import { EditorView } from '@codemirror/view';
import { easing, motion, reducedMotion } from '../../platform/motion';
import type { FileSession } from '../../editor/sessions';

const TRIES = 30;

/**
 * Once the editor has jumped to `from` (it takes the session's reveal command, which can be a
 * moment after the file opens), that line lights up once and fades. The animation runs on the
 * line element itself, so CodeMirror's own classes are left alone.
 */
export function flashLine(session: FileSession, from: number, root = '.sf-writing-editor') {
  if (reducedMotion() || typeof Element.prototype.animate !== 'function') return;
  let tries = 0;
  const attempt = () => {
    const dom = document.querySelector<HTMLElement>(`${root} .cm-editor`);
    const view = dom ? EditorView.findFromDOM(dom) : null;
    if (!view || session.pendingEditorCommand) {
      if (++tries < TRIES) window.setTimeout(attempt, 50);
      return;
    }
    const node = view.domAtPos(Math.min(from, view.state.doc.length)).node;
    const element = node instanceof Element ? node : node.parentElement;
    const line = element?.closest<HTMLElement>('.cm-line');
    line?.animate(
      [
        { backgroundColor: 'color-mix(in srgb, var(--sf-status-warning) 30%, transparent)' },
        {
          backgroundColor: 'color-mix(in srgb, var(--sf-status-warning) 30%, transparent)',
          offset: 0.3,
        },
        { backgroundColor: 'transparent' },
      ],
      { duration: motion.content * 4, easing: easing.standard },
    );
  };
  window.setTimeout(attempt, 0);
}
