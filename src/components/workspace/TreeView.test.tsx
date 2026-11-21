import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TreeView, type TreeItem } from './TreeView';

afterEach(cleanup);

const items: TreeItem[] = [
  { id: 'paper', label: 'Paper', children: [{ id: 'paper/main.tex', label: 'main.tex' }] },
  { id: 'notes.md', label: 'notes.md' },
];

it('supports modifier ranges in visible order without opening files or expanding folders', () => {
  const open = vi.fn(),
    toggle = vi.fn();
  function Example() {
    const [selection, setSelection] = useState(new Set<string>());
    return (
      <TreeView
        items={[...items, { id: 'last', label: 'Last' }]}
        label="multi"
        selectedIds={selection}
        collapsed={new Set(['paper'])}
        onOpen={open}
        onToggle={toggle}
        onSelectionChange={setSelection}
      />
    );
  }
  render(<Example />);
  const paper = screen.getByRole('treeitem', { name: 'Paper' });
  const notes = screen.getByRole('treeitem', { name: 'notes.md' });
  const last = screen.getByRole('treeitem', { name: 'Last' });
  fireEvent.click(paper, { ctrlKey: true });
  fireEvent.click(last, { shiftKey: true });
  expect(screen.getAllByRole('treeitem', { selected: true })).toHaveLength(3);
  fireEvent.click(notes, { metaKey: true });
  expect(notes.getAttribute('aria-selected')).toBe('false');
  fireEvent.keyDown(last, { key: 'a', ctrlKey: true });
  expect(screen.getAllByRole('treeitem', { selected: true })).toHaveLength(3);
  expect(open).not.toHaveBeenCalled();
  expect(toggle).not.toHaveBeenCalled();
  expect(screen.queryByRole('treeitem', { name: 'main.tex' })).toBeNull();
});

it('keeps a single tab stop and opens files only on explicit activation', async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  function Example() {
    const [collapsed, setCollapsed] = useState(new Set(['paper']));
    return (
      <TreeView
        items={items}
        label="项目文件"
        collapsed={collapsed}
        onOpen={open}
        onToggle={(id) =>
          setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
      />
    );
  }
  render(<Example />);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Paper' }));
  await user.keyboard('{ArrowRight}{ArrowRight}');
  expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'main.tex' }));
  expect(open).not.toHaveBeenCalled();
  expect(screen.getAllByRole('treeitem').filter((item) => item.tabIndex === 0)).toHaveLength(1);
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith('paper/main.tex');
  await user.keyboard('{ArrowLeft}{ArrowLeft}');
  expect(screen.queryByRole('treeitem', { name: 'main.tex' })).toBeNull();
  await user.keyboard('{End}');
  expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'notes.md' }));
});

it('renames a row in place, selecting the name without its extension', async () => {
  const user = userEvent.setup();
  const commit = vi.fn();
  function Example() {
    const [value, setValue] = useState('notes.md');
    return (
      <TreeView
        items={items}
        label="rename"
        collapsed={new Set()}
        onOpen={() => {}}
        onToggle={() => {}}
        draft={{
          id: 'notes.md',
          kind: 'file',
          parent: '',
          value,
          label: 'Name',
          onChange: setValue,
          onCommit: () => commit(value),
          onCancel: () => {},
        }}
      />
    );
  }
  render(<Example />);
  expect(document.querySelector('[data-tree-id="notes.md"]')).toBeNull();
  const field = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5]);
  await user.keyboard('todo{Enter}');
  expect(commit).toHaveBeenCalledWith('todo.md');
});
