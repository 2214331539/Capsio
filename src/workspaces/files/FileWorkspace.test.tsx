import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import type { FileSession } from '../../editor/sessions';
import { getFileRuntime } from '../../editor/sessions';
import { emptyWorkspace, type Project } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { WorkspaceBackend } from '../../platform/desktop';
import type { ResearchBackend } from '../../platform/research';
import { FileResources, FileWorkspace } from './FileWorkspace';

vi.mock('../../editor/CodeEditor', () => ({
  CodeEditor: ({
    session,
    onSelection,
  }: {
    session: FileSession;
    onSelection?: (text: string) => void;
  }) => {
    const data = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return (
      <textarea
        aria-label={`编辑 ${session.path}`}
        value={data.content}
        onChange={(event) => session.edit(event.target.value)}
        onSelect={(event) =>
          onSelection?.(
            event.currentTarget.value.slice(
              event.currentTarget.selectionStart,
              event.currentTarget.selectionEnd,
            ),
          )
        }
      />
    );
  },
}));
afterEach(cleanup);
it('reselecting an open file from the tree remembers it across page unmounts', async () => {
  const props = setup();
  const view = render(<FileWorkspace {...props} activePath="paper.md" />);
  await screen.findByRole('textbox', { name: '编辑 paper.md' });
  view.rerender(<FileWorkspace {...props} activePath="notes.md" />);
  await screen.findByRole('textbox', { name: '编辑 notes.md' });
  view.rerender(<FileWorkspace {...props} activePath="paper.md" />);
  expect(getFileRuntime(props.backend).active.get(JSON.stringify(['p1', 'writing', '']))).toBe(
    'paper.md',
  );
  view.unmount();
  render(<FileWorkspace {...props} />);
  expect(await screen.findByRole('textbox', { name: '编辑 paper.md' })).toBeTruthy();
});
it('same-named worktree files keep independent selection and AI context even with identical content', async () => {
  const props = setup();
  const view = render(
    <FileWorkspace {...props} mode="experiments" activePath="train.py" workspaceRoot="F:/main" />,
  );
  const editor = await screen.findByRole('textbox', { name: '编辑 train.py' });
  (editor as HTMLTextAreaElement).setSelectionRange(2, 7);
  fireEvent.select(editor);
  await waitFor(() =>
    expect(props.onContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceRoot: 'F:/main', selection: 'Draft' }),
    ),
  );
  view.rerender(
    <FileWorkspace {...props} mode="experiments" activePath="train.py" workspaceRoot="F:/other" />,
  );
  await waitFor(() =>
    expect(props.onContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceRoot: 'F:/other', selection: '' }),
    ),
  );
  expect(props.backend.readFile).toHaveBeenCalledWith('p1', 'train.py', 'F:/other');
});
const project: Project = {
  id: 'p1',
  name: 'Research',
  question: '',
  createdAt: '2026-09-23',
  space: 'personal',
};

function setup() {
  const workspaceBackend: WorkspaceBackend = {
    load: async () => ({ workspace: emptyWorkspace(), directory: '', legacyAvailable: false }),
    save: async (data) => data,
    restore: async () => emptyWorkspace(),
    migrateLegacy: async () => emptyWorkspace(),
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  };
  const backend: ResearchBackend = {
    listFiles: async () => [],
    readFile: vi.fn(async (_project, path) => ({ path, content: '# Draft', version: 'v1' })),
    writeFile: vi.fn(async (_project, path, content) => ({ path, content, version: 'v2' })),
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    gitStatus: async () => [],
    listModels: async () => [],
    testModel: async () => {},
    askAI: async () => '',
  };
  return {
    backend,
    store: createWorkspaceStore(workspaceBackend),
    project,
    mode: 'writing' as const,
    view: 'files',
    onContext: vi.fn(),
  };
}

it('retries a failed disk reread from the error action', async () => {
  const props = setup();
  const user = userEvent.setup();
  render(<FileWorkspace {...props} activePath="paper.md" />);
  await screen.findByRole('textbox', { name: '编辑 paper.md' });
  vi.mocked(props.backend.readFile).mockRejectedValueOnce(new Error('暂时无法读取'));
  await user.click(screen.getByRole('button', { name: '重新读取文件' }));
  expect((await screen.findByRole('alert')).textContent).toContain('暂时无法读取');
  await screen.findByText('暂时无法读取');
  vi.mocked(props.backend.readFile).mockResolvedValueOnce({
    path: 'paper.md',
    content: '# Updated',
    version: 'v2',
  });
  await user.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: '编辑 paper.md' }) as HTMLTextAreaElement).value,
    ).toBe('# Updated'),
  );
  expect(props.backend.readFile).toHaveBeenCalledTimes(3);
});

it('names new files and folders in the explorer, inside the selected folder', async () => {
  const props = setup();
  props.backend.listFiles = async () => [
    { path: 'src', name: 'src', kind: 'directory', size: 0 },
    { path: 'src/train.py', name: 'train.py', kind: 'file', size: 9 },
    { path: 'README.md', name: 'README.md', kind: 'file', size: 9 },
  ];
  props.backend.createDirectory = vi.fn(async (_project, path) => path);
  const onOpen = vi.fn();
  const user = userEvent.setup();
  const { container } = render(
    <FileResources
      project={props.project}
      backend={props.backend}
      mode="experiments"
      view="files"
      workspaceRoot="F:/main"
      onOpen={onOpen}
    />,
  );
  await user.click(await screen.findByRole('treeitem', { name: 'src' }));
  await user.click(screen.getByRole('button', { name: '新建文件夹' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  const folder = screen.getByRole('textbox', { name: '文件夹名称' });
  expect(folder.closest('[role="treeitem"]')!.getAttribute('aria-level')).toBe('2');
  await user.type(folder, 'configs{Enter}');
  await waitFor(() =>
    expect(props.backend.createDirectory).toHaveBeenCalledWith('p1', 'src/configs', 'F:/main'),
  );
  // Empty space selects the root.
  await user.click(container.querySelector('.sf-resource-tree')!);
  await user.click(screen.getByRole('button', { name: '新建文件' }));
  const file = screen.getByRole('textbox', { name: '文件名称' });
  expect(file.closest('[role="treeitem"]')!.getAttribute('aria-level')).toBe('1');
  await user.type(file, 'readme.md{Enter}');
  expect(screen.getByRole('alert').textContent).toBe('此位置已存在文件或文件夹“readme.md”。');
  vi.mocked(props.backend.writeFile).mockRejectedValueOnce(new Error('目录只读'));
  await user.clear(file);
  await user.type(file, 'eval.py{Enter}');
  expect(await screen.findByText('目录只读')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: '文件名称' }) as HTMLInputElement).value).toBe(
    'eval.py',
  );
  await user.type(screen.getByRole('textbox', { name: '文件名称' }), '{Enter}');
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('eval.py'));
  expect(props.backend.writeFile).toHaveBeenLastCalledWith('p1', 'eval.py', '', null, 'F:/main');
  expect(screen.queryByRole('textbox', { name: '文件名称' })).toBeNull();
});

it('preserves an edited buffer on navigation remount and shares it with experiments', async () => {
  const props = setup();
  const user = userEvent.setup();
  const view = render(<FileWorkspace {...props} activePath="paper.md" />);
  const editor = await screen.findByRole('textbox', { name: '编辑 paper.md' });
  await user.type(editor, '\nConclusion');
  view.unmount();
  render(<FileWorkspace {...props} mode="experiments" activePath="paper.md" />);
  expect(
    ((await screen.findByRole('textbox', { name: '编辑 paper.md' })) as HTMLTextAreaElement).value,
  ).toBe('# Draft\nConclusion');
  expect(props.backend.readFile).toHaveBeenCalledTimes(1);
});

it('saves a conflict copy with the current buffer and never silently overwrites the original', async () => {
  const props = setup();
  const user = userEvent.setup();
  vi.mocked(props.backend.writeFile).mockRejectedValueOnce(new Error('版本冲突'));
  render(<FileWorkspace {...props} activePath="paper.md" />);
  const editor = await screen.findByRole('textbox', { name: '编辑 paper.md' });
  await user.clear(editor);
  await user.type(editor, '# My important conclusion');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByText('版本冲突');
  expect(
    (screen.getByRole('textbox', { name: '编辑 paper.md' }) as HTMLTextAreaElement).value,
  ).toBe('# My important conclusion');
  await user.click(screen.getByRole('button', { name: '另存副本' }));
  await user.type(screen.getByLabelText('副本路径'), 'paper-recovered.md');
  await user.click(screen.getByRole('button', { name: '保存副本' }));
  await waitFor(() =>
    expect(props.backend.writeFile).toHaveBeenLastCalledWith(
      'p1',
      'paper-recovered.md',
      '# My important conclusion',
      null,
    ),
  );
});

it('requires explicit discard before a reread replaces an unsaved buffer', async () => {
  const props = setup();
  const user = userEvent.setup();
  render(<FileWorkspace {...props} activePath="paper.md" />);
  await user.type(await screen.findByRole('textbox', { name: '编辑 paper.md' }), ' unsaved');
  vi.mocked(props.backend.readFile).mockResolvedValue({
    path: 'paper.md',
    content: 'External revision',
    version: 'v3',
  });
  await user.click(screen.getByRole('button', { name: '重新读取文件' }));
  expect(props.backend.readFile).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '保留编辑' }));
  expect(
    (screen.getByRole('textbox', { name: '编辑 paper.md' }) as HTMLTextAreaElement).value,
  ).toBe('# Draft unsaved');
  await user.click(screen.getByRole('button', { name: '重新读取文件' }));
  await act(async () => {
    await user.click(screen.getByRole('button', { name: '丢弃编辑并重新读取' }));
  });
  expect(
    (screen.getByRole('textbox', { name: '编辑 paper.md' }) as HTMLTextAreaElement).value,
  ).toBe('External revision');
});
