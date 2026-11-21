import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button, segmentThumb } from '../../components/primitives';
import type { WorkContext } from '../../domain/context';
import type { PdfBackend, ResearchBackend } from '../../platform/research';
import { t, translateError } from '../../i18n';
import { errorMessage } from '../../domain/errors';
import MarkdownPreview from './MarkdownPreview';

const PdfReader = lazy(() => import('../../reader/PdfReader'));

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};
// Formats that are never text; anything else is tried as text first.
const BINARY =
  /\.(zip|gz|tgz|bz2|xz|7z|rar|tar|exe|dll|so|dylib|bin|o|a|lib|pyc|pt|pth|ckpt|safetensors|onnx|h5|hdf5|npy|npz|pkl|pickle|joblib|parquet|feather|arrow|mat|sqlite|db|mp3|wav|flac|ogg|m4a|mp4|mov|avi|mkv|webm|doc|docx|xls|xlsx|ppt|pptx|woff2?|ttf|otf|eot|jar|class|whl)$/i;

export type FileKind = 'image' | 'pdf' | 'binary' | 'table' | 'notebook' | 'text';
const extension = (path: string) => path.split('.').at(-1)?.toLowerCase() ?? '';
export function fileKind(path: string): FileKind {
  const ext = extension(path);
  if (IMAGE_TYPES[ext]) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (BINARY.test(path)) return 'binary';
  if (ext === 'csv' || ext === 'tsv') return 'table';
  if (ext === 'ipynb') return 'notebook';
  return 'text';
}
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Images, PDFs and files that are not text: shown as they are, never edited. */
export function BinaryView({
  backend,
  projectId,
  path,
  workspaceRoot,
  onContext,
}: {
  backend: ResearchBackend;
  projectId: string;
  path: string;
  workspaceRoot?: string;
  onContext: (context: WorkContext) => void;
}) {
  const kind = fileKind(path);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState('');
  const [actual, setActual] = useState(false);
  const [dimensions, setDimensions] = useState('');
  useEffect(() => {
    setBytes(null);
    setError('');
    setDimensions('');
    if (kind === 'pdf') return;
    if (!backend.readBinary) {
      setError(t('预览此文件需要桌面应用。'));
      return;
    }
    let alive = true;
    backend
      .readBinary(projectId, path, workspaceRoot)
      .then((value) => {
        if (alive) setBytes(value);
      })
      .catch((reason) => {
        if (alive) setError(errorMessage(reason));
      });
    return () => {
      alive = false;
    };
  }, [backend, projectId, path, workspaceRoot, kind]);
  const url = useMemo(() => {
    if (!bytes || kind !== 'image') return '';
    const copy = new Uint8Array(bytes);
    return URL.createObjectURL(new Blob([copy], { type: IMAGE_TYPES[extension(path)] }));
  }, [bytes, kind, path]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  const pdf = useMemo<PdfBackend>(
    () => ({
      readPdf: () =>
        backend.readBinary
          ? backend.readBinary(projectId, path, workspaceRoot)
          : Promise.reject(new Error(t('预览此文件需要桌面应用。'))),
    }),
    [backend, projectId, path, workspaceRoot],
  );
  const name = path.split('/').at(-1) ?? path;
  return (
    <>
      <div className="sf-file-toolbar">
        <span className="sf-file-breadcrumb" title={path}>
          {path}
        </span>
        {kind === 'image' && bytes ? (
          <div ref={segmentThumb} className="sf-file-segments" aria-label={t('图片大小')}>
            <Button variant="ghost" aria-pressed={!actual} onClick={() => setActual(false)}>
              {t('适应窗口')}
            </Button>
            <Button variant="ghost" aria-pressed={actual} onClick={() => setActual(true)}>
              {t('实际大小')}
            </Button>
          </div>
        ) : null}
        {backend.reveal ? (
          <Button
            variant="ghost"
            iconOnly
            aria-label={t('在文件管理器中显示')}
            tooltip={t('在文件管理器中显示')}
            onClick={() =>
              void backend.reveal!(projectId, path, workspaceRoot).catch((reason) =>
                setError(errorMessage(reason)),
              )
            }
          >
            <FolderOpen size={14} />
          </Button>
        ) : null}
      </div>
      <div className="sf-file-canvas">
        {kind === 'pdf' ? (
          <div className="sf-pdf-view">
            <Suspense fallback={<div className="sf-file-loading">{t('正在打开阅读器…')}</div>}>
              <PdfReader
                key={`${workspaceRoot ?? ''}:${path}`}
                assetId={`file:${workspaceRoot ?? projectId}:${path}`}
                paperId={path}
                title={name}
                projectId={projectId}
                backend={pdf}
                compact
                onContext={onContext}
                onTool={() => {}}
              />
            </Suspense>
          </div>
        ) : error ? (
          <div className="sf-file-loading" role="alert">
            {translateError(error)}
          </div>
        ) : !bytes ? (
          <div className="sf-file-loading">{t('正在读取文件…')}</div>
        ) : kind === 'image' ? (
          <div className={`sf-image-view${actual ? ' is-actual' : ''}`}>
            <img
              src={url}
              alt={name}
              onLoad={(event) =>
                setDimensions(
                  `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`,
                )
              }
            />
          </div>
        ) : (
          <div className="sf-file-loading">{t('此文件不是文本，不能在编辑器中打开。')}</div>
        )}
      </div>
      {kind !== 'pdf' && bytes ? (
        <div className="sf-file-footer">
          <span>{extension(path).toUpperCase()}</span>
          {dimensions ? <span>{dimensions}</span> : null}
          <span>{size(bytes.byteLength)}</span>
        </div>
      ) : null}
    </>
  );
}

/** Splits CSV or TSV text into rows, honouring quoted fields with commas and line breaks. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const SHOWN_ROWS = 2000;
const numeric = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i;

/** A CSV or TSV file as a table with a sticky header; numbers align right. */
export function TableView({ content, path }: { content: string; path: string }) {
  const rows = useMemo(
    () => parseDelimited(content, extension(path) === 'tsv' ? '\t' : ','),
    [content, path],
  );
  if (!rows.length) return <div className="sf-file-loading">{t('文件是空的')}</div>;
  const [header, ...body] = rows;
  const width = Math.max(...rows.slice(0, SHOWN_ROWS + 1).map((row) => row.length));
  const columns = Array.from({ length: width }, (_, index) => index);
  const numbers = columns.map((index) =>
    body
      .slice(0, SHOWN_ROWS)
      .every((row) => !row[index]?.trim() || numeric.test(row[index].trim())),
  );
  return (
    <div className="sf-table-view">
      <div className="sf-table-scroll">
        <table aria-label={path}>
          <thead>
            <tr>
              <th className="sf-table-index" />
              {columns.map((index) => (
                <th key={index} className={numbers[index] ? 'is-number' : undefined}>
                  {header[index] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.slice(0, SHOWN_ROWS).map((row, line) => (
              <tr key={line}>
                <td className="sf-table-index">{line + 1}</td>
                {columns.map((index) => (
                  <td key={index} className={numbers[index] ? 'is-number' : undefined}>
                    {row[index] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sf-table-summary">
        {t('{rows} 行 × {columns} 列', { rows: body.length, columns: width })}
        {body.length > SHOWN_ROWS ? ` · ${t('显示前 {count} 行', { count: SHOWN_ROWS })}` : ''}
      </div>
    </div>
  );
}

type NotebookOutput = {
  output_type: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
};
type NotebookCell = {
  cell_type: string;
  source?: string | string[];
  execution_count?: number | null;
  outputs?: NotebookOutput[];
};
const joined = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value.join('') : (value ?? '');
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

function Output({ output }: { output: NotebookOutput }) {
  if (output.output_type === 'stream')
    return (
      <pre className={`sf-nb-stream${output.name === 'stderr' ? ' is-error' : ''}`}>
        {joined(output.text)}
      </pre>
    );
  if (output.output_type === 'error')
    return (
      <pre className="sf-nb-stream is-error">
        {stripAnsi((output.traceback ?? []).join('\n')) || `${output.ename}: ${output.evalue}`}
      </pre>
    );
  const data = output.data ?? {};
  for (const type of ['image/png', 'image/jpeg', 'image/gif'])
    if (data[type])
      return (
        <img
          className="sf-nb-image"
          alt=""
          src={`data:${type};base64,${joined(data[type]).replace(/\s/g, '')}`}
        />
      );
  if (data['image/svg+xml'])
    return (
      <img
        className="sf-nb-image"
        alt=""
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(joined(data['image/svg+xml']))}`}
      />
    );
  if (data['text/html']) {
    const html = joined(data['text/html']);
    // Rendered without scripts or access to the app, like a notebook output in VS Code.
    const rows = (html.match(/<tr/gi) ?? []).length;
    return (
      <iframe
        className="sf-nb-html"
        sandbox=""
        title={t('输出')}
        srcDoc={`<style>body{margin:0;font:12px system-ui,sans-serif}table{border-collapse:collapse}td,th{padding:3px 8px;border-bottom:1px solid #ddd;text-align:right}</style>${html}`}
        style={{ height: Math.min(420, Math.max(60, rows * 24 + 24)) }}
      />
    );
  }
  if (data['text/markdown']) return <MarkdownPreview content={joined(data['text/markdown'])} />;
  if (data['text/plain']) return <pre className="sf-nb-stream">{joined(data['text/plain'])}</pre>;
  return null;
}

/** A Jupyter notebook as cells and saved outputs; editing happens in the source view. */
export function NotebookView({ content }: { content: string }) {
  const notebook = useMemo(() => {
    try {
      const value = JSON.parse(content) as {
        cells?: NotebookCell[];
        metadata?: { kernelspec?: { display_name?: string } };
      };
      if (!Array.isArray(value.cells)) throw new Error();
      return { cells: value.cells, kernel: value.metadata?.kernelspec?.display_name ?? '' };
    } catch {
      return null;
    }
  }, [content]);
  if (!notebook)
    return (
      <div className="sf-file-loading" role="alert">
        {t('这不是有效的 Jupyter 笔记本，可以在“源码”里查看。')}
      </div>
    );
  return (
    <div className="sf-notebook-view">
      {notebook.kernel ? <div className="sf-nb-kernel">{notebook.kernel}</div> : null}
      {notebook.cells.map((cell, index) =>
        cell.cell_type === 'markdown' ? (
          <div key={index} className="sf-nb-cell is-markdown">
            <MarkdownPreview content={joined(cell.source)} />
          </div>
        ) : (
          <div key={index} className="sf-nb-cell is-code">
            <div className="sf-nb-prompt">
              {cell.cell_type === 'code' ? `[${cell.execution_count ?? ' '}]` : ''}
            </div>
            <div className="sf-nb-body">
              <pre className="sf-nb-source">{joined(cell.source)}</pre>
              {(cell.outputs ?? []).map((output, at) => (
                <Output key={at} output={output} />
              ))}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
