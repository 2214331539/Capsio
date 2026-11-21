import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DocumentTabs } from './DocumentTabs';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tabs = [
  { id: 'library', title: 'Library', pinned: true },
  { id: 'a', title: 'A' },
  { id: 'b', title: 'B' },
  { id: 'c', title: 'C' },
];

it('closes a tab with the middle button but never the pinned one', () => {
  const close = vi.fn();
  render(<DocumentTabs tabs={tabs} activeId="a" panelId="p" onSelect={() => {}} onClose={close} />);
  fireEvent(
    screen.getByRole('tab', { name: 'B' }).parentElement!,
    new MouseEvent('auxclick', { bubbles: true, button: 1 }),
  );
  fireEvent(
    screen.getByRole('tab', { name: 'Library' }).parentElement!,
    new MouseEvent('auxclick', { bubbles: true, button: 1 }),
  );
  expect(close).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledWith('b');
});

it('drags a tab past its neighbours and reports the new order without selecting it', () => {
  // Each tab is 100px wide, laid out left to right.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const index = [...(this.parentElement?.children ?? [])].indexOf(this);
    return { left: index * 100, width: 100, top: 0, height: 30 } as DOMRect;
  });
  const reorder = vi.fn();
  const select = vi.fn();
  render(
    <DocumentTabs
      tabs={tabs}
      activeId="a"
      panelId="p"
      onSelect={select}
      onClose={() => {}}
      onReorder={reorder}
    />,
  );
  const card = screen.getByRole('tab', { name: 'A' }).parentElement!;
  card.setPointerCapture = () => {};
  card.hasPointerCapture = () => false;
  fireEvent.pointerDown(card, { button: 0, clientX: 150, pointerId: 1 });
  fireEvent.pointerMove(card, { clientX: 360, pointerId: 1 });
  fireEvent.pointerUp(card, { clientX: 360, pointerId: 1 });
  fireEvent.click(screen.getByRole('tab', { name: 'A' }));
  expect(reorder).toHaveBeenCalledWith(['library', 'b', 'c', 'a']);
  expect(select).not.toHaveBeenCalled();
});
