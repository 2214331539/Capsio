import { fireEvent, render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Menu, type MenuAnchor } from './Menu';
import { Button } from './Button';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Host({ action }: { action(): void }) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={trigger}
        onClick={() =>
          setAnchor({ x: innerWidth - 2, y: innerHeight - 2, trigger: trigger.current })
        }
      >
        Open
      </Button>
      <input aria-label="Outside" />
      <Menu label="Actions" anchor={anchor} onClose={() => setAnchor(null)}>
        <Button role="menuitem" onClick={action}>
          Edit
        </Button>
        <Button role="menuitem" disabled>
          Unavailable
        </Button>
        <Button role="menuitem" onClick={action}>
          Delete
        </Button>
      </Menu>
    </>
  );
}
it('supports keyboard navigation, skips unavailable items and restores focus after action', async () => {
  const action = vi.fn(),
    user = userEvent.setup();
  render(<Host action={action} />);
  const trigger = screen.getByRole('button', { name: 'Open' });
  await user.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Edit' }));
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));
  await user.keyboard('{Home}{Enter}');
  expect(action).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it('outside dismissal lets the destination receive focus and reopening is not lost to an old exit', async () => {
  const user = userEvent.setup();
  render(<Host action={() => {}} />);
  const trigger = screen.getByRole('button', { name: 'Open' });
  await user.click(trigger);
  screen.getByRole('menu').style.setProperty('--sf-motion-exit', '100ms');
  const outside = screen.getByRole('textbox', { name: 'Outside' });
  await user.click(outside);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(outside);
  expect(screen.getByRole('menu', { hidden: true }).getAttribute('inert')).not.toBeNull();
  await user.click(trigger);
  await screen.findByRole('menu');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 130));
  });
  expect(screen.getByRole('menu')).toBeTruthy();
  fireEvent.scroll(outside);
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(trigger);
  await user.keyboard('{End}{Escape}');
  expect(document.activeElement).toBe(trigger);
});

it('removes the visual exit layer immediately when reduced motion is requested', async () => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
  const user = userEvent.setup();
  render(<Host action={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Open' }));
  screen.getByRole('menu').style.setProperty('--sf-motion-exit', '100ms');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu', { hidden: true })).toBeNull();
});

it('runs the item clicked before closing', async () => {
  // In the app, React applies the capture phase's updates before a click bubbles; with
  // reduced motion the menu then leaves at once. Closing in the capture phase meant the
  // item's own handler never ran (the account menu's 设置 did nothing).
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
  const order: string[] = [];
  function Ordered() {
    const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
    return (
      <>
        <Button onClick={(event) => setAnchor({ x: 10, y: 10, trigger: event.currentTarget })}>
          Open
        </Button>
        <Menu
          label="Actions"
          anchor={anchor}
          onClose={() => {
            order.push('close');
            setAnchor(null);
          }}
        >
          <Button role="menuitem" onClick={() => order.push('item')}>
            Settings
          </Button>
        </Menu>
      </>
    );
  }
  const user = userEvent.setup();
  render(<Ordered />);
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await user.click(screen.getByRole('menuitem', { name: 'Settings' }));
  expect(order).toEqual(['item', 'close']);
  expect(screen.queryByRole('menu', { hidden: true })).toBeNull();
});

it('leaves focus where the item put it, such as a dialog it opened', async () => {
  const user = userEvent.setup();
  render(<Host action={() => screen.getByRole('textbox', { name: 'Outside' }).focus()} />);
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Outside' }));
});

it.each([90, 900])('keeps an upward menu above its anchor with content height %i', (height) => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return Math.min(height, parseFloat(this.style.maxHeight) || height);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
  const onClose = vi.fn();
  const { rerender } = render(
    <Menu label="Models" anchor={{ x: 120, y: 280, placement: 'top' }} onClose={onClose}>
      <Button role="menuitemradio">Model</Button>
    </Menu>,
  );
  const menu = screen.getByRole('menu');
  expect(parseFloat(menu.style.top) + menu.offsetHeight).toBe(280);
  expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8);
  expect(menu.style.left).toBe('120px');
  fireEvent.scroll(menu);
  expect(onClose).not.toHaveBeenCalled();
  // Switching back to a regular menu must not retain the previous height constraint.
  rerender(
    <Menu label="Actions" anchor={{ x: innerWidth - 2, y: 12 }} onClose={onClose}>
      <Button role="menuitem">Action</Button>
    </Menu>,
  );
  expect(menu.style.maxHeight).toBe('');
  expect(parseFloat(menu.style.left) + menu.offsetWidth).toBe(innerWidth - 8);
});

it('keeps working when another program takes focus for a moment as an item is pressed', async () => {
  const action = vi.fn();
  render(<Host action={action} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
  const edit = screen.getByRole('menuitem', { name: 'Edit' });
  vi.useFakeTimers();
  try {
    fireEvent.pointerDown(edit);
    act(() => void window.dispatchEvent(new Event('blur')));
    act(() => void window.dispatchEvent(new Event('focus')));
    act(() => void vi.advanceTimersByTime(300));
    // Closing would make the menu inert, and the click would go nowhere.
    expect(screen.getByRole('menu', { name: 'Actions' }).dataset.state).toBe('open');
    fireEvent.click(edit);
    expect(action).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('closes once the window has really lost focus', async () => {
  render(<Host action={() => {}} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
  vi.useFakeTimers();
  try {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event('blur')));
    expect(screen.getByRole('menu', { name: 'Actions' }).dataset.state).toBe('open');
    act(() => void vi.advanceTimersByTime(300));
    expect(screen.queryByRole('menu', { name: 'Actions' })?.dataset.state ?? 'closed').toBe(
      'closed',
    );
  } finally {
    vi.useRealTimers();
  }
});
