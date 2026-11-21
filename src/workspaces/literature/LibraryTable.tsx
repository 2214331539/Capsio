import { useRef, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { EmptyState } from '../../components/EmptyState';
import {
  FileText,
  FolderOpen,
  Languages,
  Library,
  MoreHorizontal,
  NotebookPen,
  Upload,
} from 'lucide-react';
import { Button } from '../../components/primitives';
import { t } from '../../i18n';
import type { LibraryEntry, LibraryPaper, PaperReference } from '../../platform/library';
import './library-table.css';

const filename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const folderOf = (path: string) => path.split('/').slice(0, -1).join('/');
const stem = (name: string) => name.replace(/\.(pdf|md|markdown|txt)$/i, '');

function size(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The page a paper was last read at, kept by the reader on this device. */
function lastPage(paperId: string | null) {
  if (!paperId) return 0;
  try {
    return Math.trunc(Number(localStorage.getItem(`scientify.reader.${paperId}`))) || 0;
  } catch {
    return 0;
  }
}

/** "Vaswani, Shazeer et al. · 2017": who and when, as a reference list shows them. */
export function byline(reference: PaperReference) {
  const names = (reference.authors ?? []).map((name) => name.split(',')[0].trim());
  const who = names.length > 2 ? `${names[0]}, ${names[1]} ${t('等')}` : names.join(', ');
  return [who, reference.venue, reference.year].filter(Boolean).join(' · ');
}

/** Every document in the chosen folder, with what the library actually knows about it. */
export function LibraryTable({
  root,
  entries,
  papers,
  folder,
  query,
  selected,
  selectedPaths,
  busy,
  readOnly,
  importing,
  onSelect,
  onSelectMany,
  onOpen,
  onNote,
  onTranslate,
  onMenu,
  onChoose,
  onImport,
  onImportLibrary,
  references = {},
  fileEvents,
}: {
  root: string | null;
  entries: LibraryEntry[];
  papers: LibraryPaper[];
  folder: string;
  query: string;
  selected: string;
  /** Every selected row, when more than one can be; `selected` stays the active one. */
  selectedPaths?: ReadonlySet<string>;
  busy: boolean;
  readOnly: boolean;
  importing: string;
  onSelect(path: string): void;
  /** Ctrl / Cmd toggles a row, Shift selects the rows in between. */
  onSelectMany?(paths: Set<string>, active: string): void;
  onOpen(path: string): void;
  /** Row actions shown on hover. */
  onNote?(path: string): void;
  onTranslate?(path: string): void;
  onMenu?(path: string, x: number, y: number): void;
  onChoose(): void;
  onImport(files: File[]): void;
  /** Opens the Zotero / BibTeX / RIS import. */
  onImportLibrary?(): void;
  /** What reference managers said about papers, by PDF fingerprint. */
  references?: Record<string, PaperReference>;
  /** Drag, drop, clipboard and menu handlers shared with the folder tree. */
  fileEvents: {
    onContextMenu(event: MouseEvent<HTMLElement>): void;
    onDragStart(event: DragEvent<HTMLElement>): void;
    onDragEnd(event: DragEvent<HTMLElement>): void;
    onDragOver(event: DragEvent<HTMLElement>): void;
    onDragLeave(event: DragEvent<HTMLElement>): void;
    onDrop(event: DragEvent<HTMLElement>): void;
    onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  };
}) {
  const picker = useRef<HTMLInputElement>(null);
  // A paper's note is a file beside it; note files themselves are not documents here.
  const present = new Set(entries.map((entry) => entry.path.toLowerCase()));
  const withNotes = new Set(
    papers
      .filter((paper) => present.has(paper.notePath.toLowerCase()))
      .map((paper) => paper.path.toLowerCase()),
  );
  const fingerprints = new Map(papers.map((paper) => [paper.id, paper.fingerprint]));
  const referenceOf = (entry: LibraryEntry) =>
    entry.paperId ? references[fingerprints.get(entry.paperId) ?? ''] : undefined;
  const term = query.trim().toLocaleLowerCase();
  const matches = (entry: LibraryEntry) => {
    if (!term) return true;
    const reference = referenceOf(entry);
    return [entry.path, reference?.title, ...(reference?.authors ?? []), reference?.year]
      .filter(Boolean)
      .some((text) => text!.toLocaleLowerCase().includes(term));
  };
  const rows = entries.filter(
    (entry) =>
      !entry.directory &&
      (entry.pdf || /\.(md|markdown|txt)$/i.test(entry.name)) &&
      !entry.note &&
      (!folder || entry.path.startsWith(`${folder}/`)) &&
      matches(entry),
  );
  const title = folder ? filename(folder) : t('全部论文');
  const anchor = useRef('');
  /** One row, or with Ctrl / Cmd / Shift a growing selection. */
  function pick(path: string, range: boolean, toggle: boolean) {
    if (!onSelectMany || (!range && !toggle)) {
      anchor.current = path;
      onSelect(path);
      return;
    }
    let next = new Set<string>();
    if (range) {
      const from = rows.findIndex((row) => row.path === (anchor.current || selected));
      const to = rows.findIndex((row) => row.path === path);
      if (toggle && selectedPaths) next = new Set(selectedPaths);
      for (const row of rows.slice(Math.min(from < 0 ? to : from, to), Math.max(from, to) + 1))
        next.add(row.path);
    } else {
      anchor.current = path;
      next = new Set(selectedPaths ?? (selected ? [selected] : []));
      if (next.has(path)) next.delete(path);
      else next.add(path);
    }
    onSelectMany(next, path);
  }
  function move(event: KeyboardEvent<HTMLElement>) {
    const index = rows.findIndex((row) => row.path === selected);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next =
        rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        pick(next.path, event.shiftKey, false);
        document
          .querySelector<HTMLElement>(`[data-library-row="${CSS.escape(next.path)}"]`)
          ?.focus();
      }
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      onOpen(selected);
    }
  }
  return (
    <section className="library-table-page" aria-label={t('文献库')}>
      <header className="library-table-head">
        <h1>{title}</h1>
        <span className="spacer" />
        {importing ? <span role="status">{importing}</span> : null}
        {onImportLibrary ? (
          <Button
            variant="ghost"
            disabled={!root || busy}
            tooltip={t('也支持 BibTeX、RIS')}
            data-tour="import-library"
            onClick={onImportLibrary}
          >
            <Library />
            {t('从 Zotero 导入')}
          </Button>
        ) : null}
        <Button
          variant="primary"
          disabled={!root || readOnly || busy}
          onClick={() => picker.current?.click()}
        >
          <Upload />
          {t('导入')}
        </Button>
        <input
          ref={picker}
          type="file"
          accept=".pdf,.md,.markdown,.txt"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length) onImport(files);
          }}
        />
      </header>
      {!root ? (
        <EmptyState
          className="library-table-empty"
          icon={<FolderOpen />}
          title={t('还没有关联文献文件夹')}
          actions={
            <Button variant="primary" onClick={onChoose}>
              {t('打开文献文件夹')}
            </Button>
          }
        >
          {t('选一个放论文的文件夹，PDF 会显示在这里。')}
        </EmptyState>
      ) : !rows.length ? (
        <EmptyState
          className="library-table-empty"
          data-tree-id={folder}
          {...fileEvents}
          icon={<FileText />}
          title={term ? t('没有符合条件的文献') : t('这里还没有文献')}
          actions={
            !term && !readOnly && onImportLibrary ? (
              <>
                <Button variant="primary" disabled={busy} onClick={onImportLibrary}>
                  <Library />
                  {t('从 Zotero 导入')}
                </Button>
                <Button disabled={busy} onClick={() => picker.current?.click()}>
                  <Upload />
                  {t('导入文件')}
                </Button>
              </>
            ) : null
          }
        >
          {term ? null : t('把 PDF 拖到这里，或从 Zotero 导入。')}
        </EmptyState>
      ) : (
        <div
          className="library-table"
          role="grid"
          aria-label={t('文献列表')}
          {...fileEvents}
          onKeyDown={(event) => {
            move(event);
            fileEvents.onKeyDown(event);
          }}
        >
          <div className="library-row is-head" role="row">
            <span role="columnheader">{t('名称')}</span>
            <span role="columnheader">{t('文件夹')}</span>
            <span role="columnheader">{t('笔记')}</span>
            <span role="columnheader">{t('读到')}</span>
            <span role="columnheader">{t('大小')}</span>
          </div>
          {rows.map((entry) => {
            const page = lastPage(entry.paperId);
            const where = folderOf(entry.path);
            const reference = referenceOf(entry);
            const chosen = entry.path === selected || !!selectedPaths?.has(entry.path);
            // A row action must not also select or open the row.
            const only = (action: () => void) => (event: MouseEvent<HTMLElement>) => {
              event.stopPropagation();
              action();
            };
            return (
              <div
                key={entry.path}
                role="row"
                tabIndex={entry.path === selected || (!selected && entry === rows[0]) ? 0 : -1}
                className={`library-row${chosen ? ' is-selected' : ''}`}
                aria-selected={chosen}
                data-tree-id={entry.path}
                data-library-row={entry.path}
                draggable={!readOnly}
                onClick={(event) =>
                  pick(entry.path, event.shiftKey, event.ctrlKey || event.metaKey)
                }
                onDoubleClick={() => onOpen(entry.path)}
              >
                <span role="gridcell" className="library-name">
                  <FileText />
                  {reference?.title ? (
                    <span className="library-name-text" title={entry.path}>
                      <span>{reference.title}</span>
                      <small>{byline(reference)}</small>
                    </span>
                  ) : (
                    <span title={entry.path}>{stem(entry.name)}</span>
                  )}
                </span>
                <span role="gridcell" className="library-meta" title={where}>
                  {where ? filename(where) : '—'}
                </span>
                <span role="gridcell" className="library-meta">
                  {withNotes.has(entry.path.toLowerCase()) ? (
                    <NotebookPen aria-label={t('有笔记')} />
                  ) : null}
                </span>
                <span role="gridcell" className="library-meta">
                  {page ? t('第 {page} 页', { page }) : ''}
                </span>
                <span role="gridcell" className="library-meta">
                  {size(entry.size)}
                </span>
                {onNote || onTranslate || onMenu ? (
                  <span
                    role="gridcell"
                    className="library-row-actions"
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    {entry.pdf && onNote ? (
                      <Button
                        variant="ghost"
                        iconOnly
                        size="sm"
                        tabIndex={-1}
                        aria-label={t('打开论文笔记')}
                        tooltip={t('打开论文笔记')}
                        disabled={busy}
                        onClick={only(() => onNote(entry.path))}
                      >
                        <NotebookPen />
                      </Button>
                    ) : null}
                    {entry.pdf && onTranslate ? (
                      <Button
                        variant="ghost"
                        iconOnly
                        size="sm"
                        tabIndex={-1}
                        aria-label={t('全文翻译')}
                        tooltip={t('全文翻译')}
                        disabled={busy}
                        onClick={only(() => onTranslate(entry.path))}
                      >
                        <Languages />
                      </Button>
                    ) : null}
                    {onMenu ? (
                      <Button
                        variant="ghost"
                        iconOnly
                        size="sm"
                        tabIndex={-1}
                        aria-label={t('更多')}
                        tooltip={t('更多')}
                        onClick={(event) => {
                          event.stopPropagation();
                          const box = event.currentTarget.getBoundingClientRect();
                          onMenu(entry.path, box.left, box.bottom);
                        }}
                      >
                        <MoreHorizontal />
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
