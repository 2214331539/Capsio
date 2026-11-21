/** Things you press answer with a lively spring; things that appear (menus, dialogs, tooltips)
 *  open calmly and leave faster than they came. See docs/UI-UX/03-交互与动效.md. */
export const motion = {
  feedback: 120,
  /** Pressing down, and the spring back on release. */
  press: 120,
  release: 220,
  /** A selection sliding between options; a badge popping in. */
  selection: 320,
  pop: 320,
  content: 220,
  navigation: 320,
  overlay: 210,
  overlayFade: 150,
  panel: 240,
  exit: 90,
  layout: 320,
  /** Hover time before the first tooltip; later ones within `tooltipGrace` show at once. */
  tooltipDelay: 500,
  tooltipGrace: 600,
} as const;

export const easing = {
  standard: 'cubic-bezier(0.42, 0, 0.58, 1)',
  enter: 'cubic-bezier(0.2, 0, 0, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  /** Overshoots a little: buttons, toggles, segmented controls. */
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  /** Overshoots barely: menus, popovers, dialogs. */
  pop: 'cubic-bezier(0.25, 1.15, 0.5, 1)',
} as const;

export const scale = {
  press: 0.93,
  pressIcon: 0.82,
  /** Wide buttons shrink by at most this many pixels in total. */
  pressMaxShrink: 8,
  popFrom: 0.97,
} as const;

export function applyMotion(root: HTMLElement) {
  for (const [scene, duration] of Object.entries(motion))
    root.style.setProperty(`--sf-motion-${kebab(scene)}`, `${duration}ms`);
  for (const [name, curve] of Object.entries(easing))
    root.style.setProperty(`--sf-ease-${name}`, curve);
  root.style.setProperty('--sf-ease-apple', easing.standard);
  root.style.setProperty('--sf-pop-from', String(scale.popFrom));
}

/** A wide button shrinks by a few pixels, not by a fixed share of its width. */
export function pressScale(width: number, icon: boolean) {
  if (icon) return scale.pressIcon;
  if (width <= 0) return scale.press;
  return Math.max(scale.press, 1 - scale.pressMaxShrink / width);
}

const PRESSABLE = '.sf-button, .sf-searchbox, [data-press]';
const NOT_PRESSABLE = ':disabled, [aria-disabled="true"], [role^="menuitem"], [data-press="off"]';

/** Buttons shrink while held and spring back on release. Driven by the Web Animations API on
 *  the `scale` property, so page styles that set their own `transition` or `transform` keep
 *  working. */
export function installPress(root: Document = document) {
  if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function')
    return () => {};
  let held: { element: HTMLElement; animation: Animation } | null = null;
  const release = () => {
    if (!held) return;
    const { element, animation } = held;
    held = null;
    const from = parseFloat(getComputedStyle(element).scale) || 1;
    animation.cancel();
    if (from !== 1 && element.isConnected)
      element.animate([{ scale: String(from) }, { scale: '1' }], {
        duration: motion.release,
        easing: easing.spring,
      });
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || reducedMotion()) return;
    const element = (event.target as Element | null)?.closest?.<HTMLElement>(PRESSABLE);
    if (!element || element.matches(NOT_PRESSABLE)) return;
    release();
    const to = pressScale(element.offsetWidth, element.classList.contains('sf-button-icon'));
    held = {
      element,
      animation: element.animate([{ scale: '1' }, { scale: String(to) }], {
        duration: motion.press,
        easing: easing.enter,
        fill: 'forwards',
      }),
    };
  };
  root.addEventListener('pointerdown', down, true);
  for (const type of ['pointerup', 'pointercancel', 'dragstart'])
    root.addEventListener(type, release, true);
  window.addEventListener('blur', release);
  return () => {
    root.removeEventListener('pointerdown', down, true);
    for (const type of ['pointerup', 'pointercancel', 'dragstart'])
      root.removeEventListener(type, release, true);
    window.removeEventListener('blur', release);
  };
}

/** A panel that has just been opened slides in from `offset` (e.g. '-8px 0'). Layout has
 *  already changed; only the panel's own pixels move. */
export function slideIn(elements: Iterable<Element | null | undefined>, offset: string) {
  if (reducedMotion()) return;
  for (const element of elements)
    element?.animate?.(
      [
        { opacity: 0, translate: offset },
        { opacity: 1, translate: '0 0' },
      ],
      { duration: motion.overlay, easing: easing.enter },
    );
}

export function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function kebab(name: string) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
