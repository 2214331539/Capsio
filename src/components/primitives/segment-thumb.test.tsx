import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { segmentThumb } from './segment-thumb';

afterEach(cleanup);

function Views() {
  const [view, setView] = useState('grid');
  return (
    <div ref={segmentThumb} role="group" aria-label="View">
      {['grid', 'list'].map((name, index) => (
        <button
          key={name}
          type="button"
          aria-pressed={view === name}
          ref={(node) => {
            if (node) Object.defineProperty(node, 'offsetLeft', { value: index * 40 });
            if (node) Object.defineProperty(node, 'offsetWidth', { value: 36 });
          }}
          onClick={() => setView(name)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

it('moves one background to the selected option', async () => {
  const user = userEvent.setup();
  render(<Views />);
  const group = screen.getByRole('group', { name: 'View' });
  expect(group.dataset.thumb).toBeTruthy();
  expect(group.style.getPropertyValue('--sf-thumb-x')).toBe('0px');
  expect(group.style.getPropertyValue('--sf-thumb-w')).toBe('36px');
  await user.click(screen.getByRole('button', { name: 'list' }));
  await Promise.resolve();
  expect(group.style.getPropertyValue('--sf-thumb-x')).toBe('40px');
});
