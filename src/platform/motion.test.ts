import { afterEach, expect, it, vi } from 'vitest';
import { installPress, pressScale, scale } from './motion';

let uninstall = () => {};
afterEach(() => {
  uninstall();
  delete (Element.prototype as Partial<Element>).animate;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function press(target: Element, type: 'pointerdown' | 'pointerup' = 'pointerdown') {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
}

function setup(html: string) {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const animations: { element: Element; frames: Keyframe[]; cancel: ReturnType<typeof vi.fn> }[] =
    [];
  // jsdom has no Web Animations API.
  Element.prototype.animate = function (
    this: Element,
    frames: Keyframe[] | PropertyIndexedKeyframes | null,
  ) {
    const animation = { element: this, frames: frames as Keyframe[], cancel: vi.fn() };
    animations.push(animation);
    return {
      cancel: animation.cancel,
      finished: Promise.resolve(),
    } as unknown as Animation;
  };
  document.body.innerHTML = html;
  uninstall = installPress();
  return animations;
}

it('shrinks wide buttons by a few pixels and icon buttons the most', () => {
  expect(pressScale(28, true)).toBe(scale.pressIcon);
  expect(pressScale(60, false)).toBe(scale.press);
  expect(pressScale(400, false)).toBeCloseTo(0.98);
  expect(pressScale(0, false)).toBe(scale.press);
});

it('presses buttons but not disabled ones or menu items', () => {
  const animations = setup(`
    <button class="sf-button" id="go"><span>Go</span></button>
    <button class="sf-button" id="off" disabled>Off</button>
    <div role="menu"><button class="sf-button" role="menuitem" id="item">Item</button></div>
  `);
  press(document.querySelector('#go span')!);
  expect(animations).toHaveLength(1);
  expect(animations[0].element.id).toBe('go');
  expect(animations[0].frames.at(-1)?.scale).toBe(String(scale.press));
  press(document.querySelector('#off')!);
  press(document.querySelector('#item')!);
  expect(animations).toHaveLength(1);
  press(document.body, 'pointerup');
  expect(animations[0].cancel).toHaveBeenCalled();
});

it('does nothing when reduced motion is requested', () => {
  const animations = setup('<button class="sf-button">Go</button>');
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  press(document.querySelector('button')!);
  expect(animations).toHaveLength(0);
});
