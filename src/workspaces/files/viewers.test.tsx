import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import type { FileSession } from '../../editor/sessions';
import { emptyWorkspace, type Project } from '../../domain/workspace';
import { createWorkspaceStore } from '../../stores/workspace';
import type { ResearchBackend } from '../../platform/research';
import { FileWorkspace } from './FileWorkspace';
import { fileKind, NotebookView, parseDelimited, TableView } from './viewers';

vi.mock('../../editor/CodeEditor', () => ({
  CodeEditor: ({ session }: { session: FileSession }) => {
    const data = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return <textarea aria-label={`编辑 ${session.path}`} value={data.content} readOnly />;
  },
}));
vi.mock('../../shell/OfficeViews', () => ({
  DocxView: ({ bytes }: { bytes: Uint8Array }) => <p>Word {bytes.length}</p>,
  PptxView: () => <p>PowerPoint</p>,
}));
afterEach(cleanup);

it('tells images, PDFs, binaries, tables and notebooks apart by extension', () => {
  expect(fileKind('figures/loss.PNG')).toBe('image');
  expect(fileKind('paper/main.pdf')).toBe('pdf');
  expect(fileKind('checkpoints/best.pt')).toBe('binary');
  expect(fileKind('data/events.tsv')).toBe('table');
  expect(fileKind('notebooks/explore.ipynb')).toBe('notebook');
  expect(fileKind('train.py')).toBe('text');
});

it('parses quoted CSV fields with commas, quotes and line breaks', () => {
  expect(parseDelimited('a,b\r\n1,"x, ""y"""\n2,"line\nbreak"\n', ',')).toEqual([
    ['a', 'b'],
    ['1', 'x, "y"'],
    ['2', 'line\nbreak'],
  ]);
  expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([
    ['a', 'b'],
    ['1', '2'],
  ]);
});

it('shows a table with a header row and right-aligned numbers', () => {
  render(<TableView path="data/events.csv" content={'name,score\nalpha,0.71\nbeta,1e-3\n'} />);
  const table = screen.getByRole('table', { name: 'data/events.csv' });
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent),
  ).toEqual(['', 'name', 'score']);
  expect(within(table).getByText('0.71').className).toBe('is-number');
  expect(within(table).getByText('alpha').className).toBe('');
  expect(screen.getByText('2 行 × 2 列')).toBeTruthy();
});

it('renders notebook cells with their saved outputs and no scripts', () => {
  const notebook = {
    metadata: { kernelspec: { display_name: 'Python 3 (.venv)' } },
    cells: [
      { cell_type: 'markdown', source: ['# Explore\n', 'Event counts'] },
      {
        cell_type: 'code',
        execution_count: 3,
        source: 'df.head()',
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['loaded 1200 rows\n'] },
          { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo=' } },
          {
            output_type: 'execute_result',
            data: { 'text/html': '<table><tr><td>1</td></tr></table>' },
          },
          {
            output_type: 'error',
            ename: 'KeyError',
            evalue: "'x'",
            traceback: ['\u001b[31mKeyError\u001b[0m: x'],
          },
        ],
      },
    ],
  };
  const { container } = render(<NotebookView content={JSON.stringify(notebook)} />);
  expect(screen.getByRole('heading', { name: 'Explore' })).toBeTruthy();
  expect(screen.getByText('[3]')).toBeTruthy();
  expect(screen.getByText('df.head()')).toBeTruthy();
  expect(screen.getByText('loaded 1200 rows')).toBeTruthy();
  expect(container.querySelector('img')!.getAttribute('src')).toBe(
    'data:image/png;base64,iVBORw0KGgo=',
  );
  expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBe('');
  expect(screen.getByText('KeyError: x')).toBeTruthy();
  expect(screen.getByText('Python 3 (.venv)')).toBeTruthy();
});

function setup() {
  const project: Project = { id: 'p1', name: 'P', question: '', space: 'personal', createdAt: '' };
  const store = createWorkspaceStore({
    load: async () => ({ workspace: emptyWorkspace(), directory: '', legacyAvailable: false }),
    save: async (data) => data,
    restore: async () => emptyWorkspace(),
    migrateLegacy: async () => emptyWorkspace(),
    importWorkspace: async () => null,
    exportWorkspace: async () => true,
    chooseDirectory: async () => null,
  });
  const backend: ResearchBackend = {
    listFiles: async () => [],
    readFile: vi.fn(async (_project, path) => ({
      path,
      content: 'step,loss\n1,0.9\n2,0.7\n',
      version: 'v1',
    })),
    writeFile: vi.fn(),
    readBinary: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    reveal: vi.fn(async () => {}),
    importPdf: async () => null,
    readPdf: async () => new Uint8Array(),
    gitStatus: async () => [],
    listModels: async () => [],
    testModel: async () => {},
    askAI: async () => '',
  };
  return { project, store, backend };
}

it('opens images from their bytes and never reads them as text', async () => {
  const { project, store, backend } = setup();
  URL.createObjectURL = vi.fn(() => 'blob:loss');
  URL.revokeObjectURL = vi.fn();
  const user = userEvent.setup();
  render(
    <FileWorkspace
      project={project}
      store={store}
      backend={backend}
      mode="experiments"
      view="files"
      activePath="figures/loss.png"
      workspaceRoot="F:/main"
      onContext={vi.fn()}
    />,
  );
  expect(((await screen.findByRole('img', { name: 'loss.png' })) as HTMLImageElement).src).toBe(
    'blob:loss',
  );
  expect(backend.readBinary).toHaveBeenCalledWith('p1', 'figures/loss.png', 'F:/main');
  expect(backend.readFile).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '在文件管理器中显示' }));
  expect(backend.reveal).toHaveBeenCalledWith('p1', 'figures/loss.png', 'F:/main');
});

it('opens a CSV as a table and its text in the source view', async () => {
  const { project, store, backend } = setup();
  const user = userEvent.setup();
  render(
    <FileWorkspace
      project={project}
      store={store}
      backend={backend}
      mode="experiments"
      view="files"
      activePath="metrics.csv"
      onContext={vi.fn()}
    />,
  );
  expect(await screen.findByRole('table', { name: 'metrics.csv' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '源码' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('textbox', { name: '编辑 metrics.csv' }) as HTMLTextAreaElement).value,
    ).toContain('step,loss'),
  );
});

it('shows Word and PowerPoint files in the editor area and names the formats it cannot show', async () => {
  const { project, store, backend } = setup();
  const open = (activePath: string) => (
    <FileWorkspace
      project={project}
      store={store}
      backend={backend}
      mode="experiments"
      view="files"
      activePath={activePath}
      workspaceRoot="F:/main"
      onContext={vi.fn()}
    />
  );
  const view = render(open('report/summary.docx'));
  expect(await screen.findByText('Word 4')).toBeTruthy();
  expect(backend.readBinary).toHaveBeenCalledWith('p1', 'report/summary.docx', 'F:/main');
  view.rerender(open('slides/talk.pptx'));
  expect(await screen.findByText('PowerPoint')).toBeTruthy();
  view.rerender(open('data/raw.xlsx'));
  expect(await screen.findByText('这种格式不能在应用里预览。')).toBeTruthy();
  expect(backend.readFile).not.toHaveBeenCalled();
});

it('previews an HTML file in the built-in browser from its editor', async () => {
  const { project, store, backend } = setup();
  const user = userEvent.setup();
  const previews: unknown[] = [];
  const listen = (event: Event) => previews.push((event as CustomEvent).detail);
  window.addEventListener('capsio-preview-file', listen);
  render(
    <FileWorkspace
      project={project}
      store={store}
      backend={backend}
      mode="experiments"
      view="files"
      activePath="plots/loss.html"
      workspaceRoot="F:/main"
      onContext={vi.fn()}
    />,
  );
  await user.click(await screen.findByRole('button', { name: '预览' }));
  expect(previews).toEqual([{ projectId: 'p1', root: 'F:/main', path: 'plots/loss.html' }]);
  window.removeEventListener('capsio-preview-file', listen);
});
