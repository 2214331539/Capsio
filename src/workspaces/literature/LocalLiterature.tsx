import { Menu } from '../../components/primitives/Menu';
import { confirmAction } from '../../components/prompts';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import {
  FolderOpen,
  FolderPlus,
  Search,
  RefreshCw,
  MoreHorizontal,
  Languages,
  NotebookPen,
  FileText,
  Folder,
  X,
  Trash2,
} from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import { dismissToast, toast, toastUndo, updateToast } from '../../components/feedback';
import { TreeView, type TreeItem } from '../../components/workspace/TreeView';
import { DocumentTabs } from '../../components/workspace/DocumentTabs';
import { ResizeHandle } from '../../shell/ResizeHandle';
import { Modal } from '../../components/Modal';
import { locale, t, translateError } from '../../i18n';
import { useActiveView } from '../../components/workspace/ViewTransition';
import {
  nativeLibrary,
  noteFiles,
  type LibraryBackend,
  type LibraryScan,
  type LibraryOperation,
} from '../../platform/library';
import {
  browserCommand,
  browserEvents,
  browserLayout,
  type BrowserTab,
} from '../../platform/browser-pane';
import {
  beginFileOperation,
  getFileRuntime,
  invalidateProjectFileSessions,
  notifyFileRuntime,
} from '../../editor/sessions';
import {
  emptyLocalSession,
  readLocalSession,
  saveLocalSession,
  openLocalPdf,
  openLocalText,
  closeLocalTab,
  paperNote,
  notesDirty,
  notesPending,
} from './local-session';
import { PaperNotes } from './PaperNotes';
import { PaperTranslation } from './PaperTranslation';
import {
  isTranslationTab,
  paperOfTab,
  translationTab,
} from '../../features/translation/paper-translation';
import { TranslationIcon, useTranslationStatus } from '../../features/translation/ProgressRing';
import { translator } from '../../platform/translator';
import { skipResumeHint } from '../../reader/resume';
import { BatchBar } from './BatchBar';
import { BrowserPane } from './BrowserPane';
import { FeaturePlaceholder } from '../../components/workspace/FeaturePlaceholder';
import TextMarkdownPreview from '../files/MarkdownPreview';
import '../files/files.css';
import type { Project } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';
import type { PdfBackend, ResearchBackend } from '../../platform/research';
import type { WorkContext } from '../../domain/context';
import { errorMessage } from '../../domain/errors';
import { canEditProject, requestProjectSync } from '../../platform/collaboration';
import './local-literature.css';

import { createPortal } from 'react-dom';
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { BookOpen, Upload } from 'lucide-react';
import { useSidebarSlot } from '../../shell/Sidebar';
import { LibraryTable } from './LibraryTable';
import { ImportLibrary } from './ImportLibrary';
import type { LibraryPaper, PaperReference } from '../../platform/library';

const PdfReader = lazy(() => import('../../reader/PdfReader'));
type RecordStore = import('../../reader/PdfReader').RecordStore;
/** The pinned first tab: the library table itself. */
const HOME = '__library__';
/** The narrowest the paper may get beside its note (the AI panel leaves 320 to the center). */
const MIN_NOTE_WIDTH = 240;
const parent = (path: string) => path.split('/').slice(0, -1).join('/');
const filename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const textExtensions =
  /\.(md|markdown|mdown|txt|text|csv|tsv|json|tex|bib|xml|yaml|yml|toml|ini|log|rst|py|js|jsx|ts|tsx|css|scss|html|sql|sh|ps1|c|cc|cpp|h|hpp)$/i;
const isTextEntry = (entry: { name: string; directory: boolean; note: boolean }) =>
  !entry.directory && (entry.note || textExtensions.test(entry.name));
const isBelowPath = (path: string, parentPath: string) =>
  path === parentPath || path.startsWith(`${parentPath}/`);

export function LocalLiterature({
  project,
  store,
  backend,
  library = nativeLibrary,
  width,
  resize,
  onContext,
  requestedPaper,
  requestedBrowser,
  requestedNewBrowser,
  onNewBrowserHandled,
}: {
  project: Project;
  store: WorkspaceStore;
  backend: ResearchBackend;
  library?: LibraryBackend;
  width: number;
  resize?: ReactNode;
  onContext: (context: WorkContext) => void;
  requestedPaper?: string | null;
  requestedBrowser?: string;
  /** The title bar asked for a new browser tab; open one and report it handled. */
  requestedNewBrowser?: boolean;
  onNewBrowserHandled?: () => void;
}) {
  const readOnly = !canEditProject(project, 'library');
  const viewActive = useActiveView();
  // Inside a project the folder tree lives in the app sidebar while this module is showing.
  const slot = useSidebarSlot();
  const workspaceBusy = useStore(store, (s) => s.busy);
  const [scan, setScan] = useState<LibraryScan>({
    root: null,
    entries: [],
    papers: [],
    warnings: [],
  });
  const [session, setSession] = useState(() => readLocalSession(project.id));
  const [importOpen, setImportOpen] = useState(false);
  // Title, authors and year of papers that came from a reference manager, by fingerprint.
  const [references, setReferences] = useState<Record<string, PaperReference>>({});
  const browserRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      requestedBrowser &&
      browserRequest.current !== requestedBrowser &&
      session.tabs.some((tab) => tab.id === requestedBrowser)
    ) {
      browserRequest.current = requestedBrowser;
      setSession((current) => ({ ...current, active: requestedBrowser }));
    }
  }, [requestedBrowser, session.tabs]);
  useEffect(() => {
    if (!requestedNewBrowser) return;
    onNewBrowserHandled?.();
    void openWebTab().catch((e) => setError(errorMessage(e)));
  }, [requestedNewBrowser]);
  const [query, setQuery] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [showNotes, setShowNotes] = useState(false),
    [collapsed, setCollapsed] = useState(new Set<string>());
  const [selected, setSelected] = useState(''),
    [selectedPaths, setSelectedPaths] = useState(new Set<string>()),
    [clipboard, setClipboard] = useState<{ paths: string[]; copy: boolean } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState('');
  // Files are being dragged over the page from outside.
  const [pageDrag, setPageDrag] = useState(false);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  // Where the batch bar's folder list opens.
  const [moveMenu, setMoveMenu] = useState<{
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
  // A folder or file being named in place in the tree (VS Code style), not a dialog; `id` is
  // set when an existing row is renamed.
  const [draft, setDraft] = useState<{
    id?: string;
    kind?: 'file' | 'folder';
    parent: string;
    value: string;
    error?: string;
  } | null>(null);
  const [dialog, setDialog] = useState<{
    kind: 'move' | 'relink';
    path: string;
    value: string;
  } | null>(null);
  const search = useRef<HTMLInputElement>(null),
    host = useRef<HTMLDivElement>(null),
    alive = useRef(true),
    generation = useRef(0),
    drag = useRef<string[]>([]);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const [hostWidth, setHostWidth] = useState(0);
  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setHostWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The area the paper and its note share, and whether this drag already closed one.
  const splitArea = useRef<HTMLDivElement>(null);
  const splitClosed = useRef(false);
  const [splitWidth, setSplitWidth] = useState(0);
  useEffect(() => {
    const element = splitArea.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setSplitWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const currentSession = useRef(session);
  currentSession.current = session;
  const actionPending = useRef(false);
  useEffect(() => {
    if (!viewActive) return;
    const preventFileNavigation = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    const endPageDrag = () => setPageDrag(false);
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    window.addEventListener('drop', endPageDrag);
    window.addEventListener('dragend', endPageDrag);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
      window.removeEventListener('drop', endPageDrag);
      window.removeEventListener('dragend', endPageDrag);
      setPageDrag(false);
    };
  }, [viewActive]);
  const changed = useRef(onContext);
  changed.current = viewActive ? onContext : () => {};
  const panelId = useId(),
    notePanel = useId();
  const active = session.tabs.find((t) => t.id === session.active),
    paper = scan.papers.find((p) => p.id === active?.paperId);
  // Translation tabs show how far their translation has got.
  const translationStatus = useTranslationStatus(
    project.id,
    session.notes.filter(isTranslationTab).flatMap((id) => {
      const bound = scan.papers.find((p) => p.id === paperOfTab(id));
      return bound ? [{ id: bound.id, fingerprint: bound.fingerprint }] : [];
    }),
  );
  const [selection, setSelection] = useState<WorkContext>();
  // The open paper's highlights live in its record, which follows the PDF.
  const paperId = paper?.id;
  const recordStore = useMemo<RecordStore | undefined>(
    () =>
      paperId && library.record && library.saveRecord
        ? {
            load: () => library.record!(project.id, paperId),
            save: async (record) => {
              const saved = await library.saveRecord!(project.id, paperId, record);
              requestProjectSync(project.id);
              return saved;
            },
          }
        : undefined,
    [library, project.id, paperId],
  );
  /** Adds a passage to the end of the paper's note and shows the note. */
  async function quote(id: string, text: string, page: number) {
    try {
      const note = paperNote(library, project.id, id);
      if (note.getSnapshot().phase !== 'ready') await note.load();
      const current = note.getSnapshot().content.trimEnd();
      const passage = text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      note.edit(
        `${current}${current ? '\n\n' : ''}${passage}\n>\n> —— ${t('第 {page} 页', { page })}\n`,
      );
      setSession((s) => ({
        ...s,
        notes: s.notes.includes(id) ? s.notes : [...s.notes, id],
        activeNote: id,
        showNotes: true,
      }));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }
  const requestedPath = scan.papers.find((p) => p.id === requestedPaper)?.path;
  useEffect(() => {
    if (requestedPath) void open(requestedPath);
  }, [requestedPath, requestedPaper]);
  const selectedEntry = scan.entries.find((e) => e.path === selected);
  const directory = selectedEntry?.directory ? selected : parent(selected);
  const protect = () => {
    if (readOnly) throw new Error(t('当前角色只允许阅读文献。'));
    if (workspaceBusy) throw new Error(t('请等待当前保存完成。'));
    if (notesDirty(library) || notesPending(library))
      throw new Error(t('请先保存论文笔记，再操作文件。'));
  };
  const refresh = useCallback(async () => {
    const ticket = ++generation.current;
    try {
      const next = await library.command(project.id, { op: 'scan' });
      if (alive.current && ticket === generation.current) {
        setScan(next);
        setError('');
        setSession((previous) =>
          previous.root && next.root && previous.root !== next.root
            ? { ...emptyLocalSession(), root: next.root }
            : { ...previous, root: next.root },
        );
      }
    } catch (e) {
      if (alive.current && ticket === generation.current) setError(errorMessage(e));
    }
  }, [project.id, library]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const events = library.changed((id, eventError) => {
      if (id === project.id) {
        if (eventError) setError(eventError);
        else void refresh();
        for (const note of getFileRuntime(noteFiles(library)).sessions.values())
          if (
            note.projectId === id &&
            !note.getSnapshot().dirty &&
            note.getSnapshot().phase === 'ready'
          )
            void note.reloadDiscardingEdits();
      }
    });
    return () => {
      alive.current = false;
      ++generation.current;
      void events.then((stop) => stop());
      void browserLayout({ op: 'hideAll' }).catch(() => {});
    };
  }, [project.id, library, refresh]);
  useEffect(() => {
    saveLocalSession(project.id, session);
  }, [project.id, session]);
  useEffect(() => {
    if (!scan.root || !library.references) return;
    let live = true;
    library
      .references(project.id)
      .then((next) => {
        if (live) setReferences(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [library, project.id, scan]);
  useEffect(() => {
    if (!viewActive) return;
    if (active?.kind !== 'web') void browserLayout({ op: 'hideAll' }).catch(() => {});
    setSelection(undefined);
    changed.current({
      projectId: project.id,
      workspace: 'literature',
      title: active?.title || t('文献'),
      resourceId: active?.paperId ?? active?.path,
      ...(active?.kind === 'text' && active.path ? { path: active.path } : {}),
      ...(active?.kind === 'web' ? { browser: { tabId: active.id, url: active.url ?? '' } } : {}),
    });
  }, [active?.id, active?.kind, active?.title, active?.url, project.id, viewActive]);
  useEffect(() => {
    const listener = browserEvents('browser-created', (tab) => {
      if (tab.projectId !== project.id) return;
      setSession((s) => ({
        ...s,
        tabs: [
          ...s.tabs.filter((existing) => existing.id !== tab.id),
          { id: tab.id, kind: 'web', title: tab.title || t('浏览器新页'), url: tab.url },
        ],
        active: tab.background ? s.active : tab.id,
      }));
    });
    let cancelled = false;
    void browserCommand<BrowserTab[]>({ op: 'snapshot' })
      .then(async (current) => {
        if (cancelled) return;
        const discovered = current.filter((tab) => tab.projectId === project.id);
        setSession((s) => ({
          ...s,
          tabs: [
            ...s.tabs,
            ...discovered
              .filter((tab) => !s.tabs.some((old) => old.id === tab.id))
              .map((tab) => ({
                id: tab.id,
                kind: 'web' as const,
                title: tab.title || t('浏览器新页'),
                url: tab.url,
              })),
          ],
        }));
        for (const old of currentSession.current.tabs.filter((t) => t.kind === 'web')) {
          if (cancelled || current.some((t) => t.id === old.id)) continue;
          const next = await browserCommand<BrowserTab>({ op: 'open', project_id: project.id });
          if (cancelled) {
            await browserCommand({ op: 'close', id: next.id });
            return;
          }
          setSession((s) => ({
            ...s,
            tabs: s.tabs.map((t) => (t.id === old.id ? { ...t, id: next.id } : t)),
            active: s.active === old.id ? next.id : s.active,
          }));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
      void listener.then((stop) => stop());
    };
  }, [project.id]);
  async function run(action: () => Promise<void>) {
    if (actionPending.current) return false;
    actionPending.current = true;
    setBusy(true);
    setError('');
    const finish = beginFileOperation(backend);
    try {
      await action();
      return true;
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
      return false;
    } finally {
      finish();
      actionPending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const selectPdf = async (path: string) => {
    const binding = await library.open(project.id, path);
    if (!alive.current) return;
    setScan((s) => ({ ...s, papers: [...s.papers.filter((p) => p.id !== binding.id), binding] }));
    setSession((s) => openLocalPdf(s, binding.id, filename(binding.path)));
    setSelected(path);
  };
  async function open(path: string) {
    const entry = scan.entries.find((e) => e.path === path);
    if (!entry) return;
    await run(async () => {
      if (entry.pdf) await selectPdf(path);
      else if (isTextEntry(entry) && library.readFile) {
        setSession((s) => openLocalText(s, path, entry.name));
        setSelected(path);
      } else await library.external(project.id, path, true);
    });
  }
  const undoMoves = useRef<(moves: { from: string; to: string }[]) => Promise<void>>(
    async () => {},
  );
  async function mutate(operation: LibraryOperation) {
    return run(async () => {
      protect();
      const next = await library.command(project.id, operation);
      setScan(next);
      requestProjectSync(project.id);
      if (operation.op === 'delete') {
        const remaining = new Set(next.papers.map((paper) => paper.id));
        const files = noteFiles(library);
        const runtime = getFileRuntime(files);
        for (const [key, note] of runtime.sessions) {
          if (note.projectId === project.id && !remaining.has(note.path))
            runtime.sessions.delete(key);
        }
        notifyFileRuntime(files);
        setSelected('');
        setSelectedPaths(new Set());
        setClipboard((value) =>
          value
            ? { ...value, paths: value.paths.filter((path) => !isBelowPath(path, operation.path)) }
            : value,
        );
        setSession((previous) => {
          let current = previous;
          for (const tab of previous.tabs)
            if (
              (tab.paperId && !remaining.has(tab.paperId)) ||
              (tab.kind === 'text' && tab.path && isBelowPath(tab.path, operation.path))
            )
              current = closeLocalTab(current, tab.id);
          const notes = current.notes.filter((id) => remaining.has(paperOfTab(id)));
          return {
            ...current,
            notes,
            activeNote:
              current.activeNote && notes.includes(current.activeNote)
                ? current.activeNote
                : (notes.at(-1) ?? null),
            showNotes: current.showNotes && notes.length > 0,
          };
        });
      }
      if (operation.op === 'transfer' && !operation.copy) {
        setSelected(operation.destination);
        setSelectedPaths(new Set([operation.destination]));
        setClipboard(null);
        remapTabs(operation.path, operation.destination);
        const name = filename(operation.destination);
        offerUndoMove(
          parent(operation.path) === parent(operation.destination)
            ? t('已重命名为“{name}”', { name })
            : t('已移动“{name}”', { name }),
          [{ from: operation.path, to: operation.destination }],
        );
      }
    });
  }
  /** A finished move or rename is undone for real: each item goes back to where it was. */
  function offerUndoMove(message: string, moves: { from: string; to: string }[]) {
    toastUndo(message, () => undoMoves.current(moves));
  }
  undoMoves.current = async (moves) => {
    await run(async () => {
      protect();
      for (const move of [...moves].reverse()) {
        const next = await library.command(project.id, {
          op: 'transfer',
          path: move.to,
          destination: move.from,
          copy: false,
        });
        setScan(next);
        requestProjectSync(project.id);
        remapTabs(move.to, move.from);
      }
      setSelected(moves.at(-1)!.from);
      setSelectedPaths(new Set(moves.map((move) => move.from)));
    });
  };
  async function choose() {
    await run(async () => {
      protect();
      const next = await library.choose(project.id);
      if (next) {
        invalidateProjectFileSessions(noteFiles(library), project.id);
        for (const tab of session.tabs)
          if (tab.kind === 'web') await browserCommand({ op: 'close', id: tab.id });
        setSession({ ...emptyLocalSession(), root: next.root });
        setSelected('');
        setSelectedPaths(new Set());
        setClipboard(null);
        setScan(next);
      }
    });
  }
  async function openWebTab() {
    const tab = await browserCommand<BrowserTab>({ op: 'open', project_id: project.id });
    setSession((s) => ({
      ...s,
      tabs: [
        ...s.tabs.filter((existing) => existing.id !== tab.id),
        { id: tab.id, title: t('浏览器新页'), kind: 'web' },
      ],
      active: tab.id,
    }));
  }
  async function newWeb() {
    await run(openWebTab);
  }
  function importFiles(files: File[], folder: string, hasDirectory = false) {
    return run(async () => {
      protect();
      if (!scan.root) throw new Error(t('请先打开文献文件夹。'));
      if (hasDirectory || !files.length) throw new Error(t('请拖入文件，暂不支持整文件夹导入。'));
      if (files.some((file) => file.size > 150 * 1024 * 1024))
        throw new Error(t('文件名无效或文件超过 150 MiB。'));
      let completed = 0;
      const progress = (current: number) =>
        t('导入文件 {current}/{total}', { current, total: files.length });
      const card = toast(progress(1), { progress: 0 });
      try {
        for (const file of files) {
          const label = progress(completed + 1);
          setImportProgress(label);
          updateToast(card, { message: label, progress: completed / files.length });
          const next = await library.importFile(project.id, folder, file);
          completed++;
          requestProjectSync(project.id);
          if (alive.current) setScan(next);
        }
        updateToast(card, {
          message: t('已导入 {count} 个文件', { count: completed }),
          tone: 'success',
          progress: undefined,
          duration: 2500,
        });
      } catch (error) {
        dismissToast(card);
        throw new Error(
          t('已导入 {count} 个文件。{error}', {
            count: completed,
            error: translateError(errorMessage(error)),
          }),
        );
      } finally {
        if (alive.current) setImportProgress('');
      }
    });
  }
  async function closeTab(id: string) {
    const tab = session.tabs.find((t) => t.id === id);
    if (tab?.kind === 'web') await browserCommand({ op: 'close', id });
    setSession((s) => closeLocalTab(s, id));
  }
  /** Shows a page of a paper, from a page link in its note or translation. */
  function openPaperPage(id: string, page: number) {
    const bound = scan.papers.find((p) => p.id === id);
    if (!bound) return;
    // The reader opens on this page by request, not as a return to where it was left.
    skipResumeHint(id);
    try {
      localStorage.setItem(`scientify.reader.${id}`, String(page));
    } catch {
      /* Optional location. */
    }
    setSession((s) => openLocalPdf(s, id, filename(bound.path)));
    requestAnimationFrame(() =>
      window.dispatchEvent(
        new CustomEvent('scientify-pdf-page', {
          detail: { paperId: id, page },
        }),
      ),
    );
  }
  /** Opens a paper's full-text translation beside it, as its note opens. */
  function openTranslation(paperId: string) {
    const id = translationTab(paperId);
    setSession((s) => ({
      ...s,
      notes: s.notes.includes(id) ? s.notes : [...s.notes, id],
      activeNote: id,
      showNotes: true,
    }));
  }
  async function closeNote(id: string) {
    // A translation saves as it goes; only notes have edits to keep.
    if (!isTranslationTab(id)) {
      const note = paperNote(library, project.id, id);
      if (note.getSnapshot().phase === 'saving' || note.getSnapshot().phase === 'loading') return;
      if (note.getSnapshot().dirty && !(await note.save())) {
        setError(note.getSnapshot().error ?? t('保存失败，请重试。'));
        return;
      }
      if (note.getSnapshot().dirty || note.getSnapshot().phase === 'saving') return;
    }
    setSession((s) => {
      const notes = s.notes.filter((n) => n !== id);
      return {
        ...s,
        notes,
        activeNote: s.activeNote === id ? (notes.at(-1) ?? null) : s.activeNote,
        showNotes: notes.length > 0,
      };
    });
  }
  const reader = useMemo<PdfBackend>(
    () => ({ readPdf: (id) => library.pdf(project.id, id) }),
    [library, project.id],
  );
  const visible = scan.entries.filter((e) => showNotes || !e.note);
  const matches = new Set<string>();
  for (const e of visible)
    if (!query || e.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
      matches.add(e.path);
      let p = parent(e.path);
      while (p) {
        matches.add(p);
        p = parent(p);
      }
    }
  const nodes = new Map<string, TreeItem>();
  for (const entry of visible.filter((e) => matches.has(e.path)))
    nodes.set(entry.path, {
      id: entry.path,
      label: entry.name,
      tooltip: entry.path,
      draggable: !readOnly,
      ...(entry.directory ? { children: [] } : {}),
    });
  const tree: TreeItem[] = [];
  for (const [path, item] of nodes) {
    const p = parent(path);
    if (p && nodes.has(p)) nodes.get(p)!.children!.push(item);
    else tree.push(item);
  }
  // Folders before files, each group in natural name order, as in VS Code's explorer.
  const collator = new Intl.Collator(locale(), { numeric: true, sensitivity: 'base' });
  const arrange = (items: TreeItem[]) => {
    items.sort(
      (a, b) =>
        Number(a.children === undefined) - Number(b.children === undefined) ||
        collator.compare(a.label, b.label),
    );
    for (const item of items) if (item.children) arrange(item.children);
  };
  arrange(tree);
  const target = menu?.path ?? selected;
  const targetEntry = scan.entries.find((e) => e.path === target);
  const targetFolder = targetEntry?.directory ? target : parent(target);
  function remapTabs(source: string, destination: string) {
    setSession((previous) => ({
      ...previous,
      tabs: previous.tabs.map((tab) =>
        tab.kind === 'text' && tab.path && isBelowPath(tab.path, source)
          ? {
              ...tab,
              path: destination + tab.path.slice(source.length),
              title: filename(destination + tab.path.slice(source.length)),
            }
          : tab,
      ),
    }));
  }
  function transferPaths(paths: Iterable<string>) {
    const existing = [...new Set(paths)].filter((path) =>
      scan.entries.some((entry) => entry.path === path),
    );
    return existing.filter(
      (path) =>
        !existing.some((other) => other !== path && isBelowPath(path, other)) &&
        !scan.papers.some((paper) => paper.notePath === path && existing.includes(paper.path)) &&
        !scan.entries.some(
          (entry) =>
            entry.pdf &&
            existing.includes(entry.path) &&
            entry.path.replace(/\.pdf$/i, '.notes.md').toLowerCase() === path.toLowerCase(),
        ),
    );
  }
  function selectedBundle(path: string) {
    return transferPaths(selectedPaths.has(path) ? selectedPaths : [path]);
  }
  async function transferMany(paths: string[], folder: string, copy: boolean) {
    await run(async () => {
      protect();
      const operations = transferPaths(paths)
        .map((path) => ({
          op: 'transfer' as const,
          path,
          destination: pasteDestination(path, folder, copy),
          copy,
        }))
        .filter((operation) => operation.copy || operation.path !== operation.destination);
      const destinations = new Set<string>();
      for (const operation of operations) {
        if (isBelowPath(folder, operation.path))
          throw new Error(t('不能将文件夹移动到自身或子目录中。'));
        const pairedNotes = scan.entries
          .filter((entry) => entry.pdf && isBelowPath(entry.path, operation.path))
          .map((entry) =>
            (operation.destination + entry.path.slice(operation.path.length)).replace(
              /\.pdf$/i,
              '.notes.md',
            ),
          );
        for (const destination of [operation.destination, ...pairedNotes]) {
          const normalized = destination.toLowerCase();
          if (
            destinations.has(normalized) ||
            scan.entries.some((entry) => entry.path.toLowerCase() === normalized)
          )
            throw new Error(t('目标文件已存在：{path}', { path: destination }));
          destinations.add(normalized);
        }
      }
      const completed: string[] = [];
      try {
        for (const operation of operations) {
          const next = await library.command(project.id, operation);
          setScan(next);
          requestProjectSync(project.id);
          completed.push(operation.destination);
          if (!copy) remapTabs(operation.path, operation.destination);
        }
        if (!copy) setClipboard(null);
      } catch (reason) {
        throw new Error(
          t('已完成 {count} 个文件操作。{error}', {
            count: completed.length,
            error: errorMessage(reason),
          }),
        );
      } finally {
        if (completed.length) {
          setSelected(completed.at(-1)!);
          setSelectedPaths(
            new Set([
              ...completed,
              ...operations.slice(completed.length).map((operation) => operation.path),
            ]),
          );
          // A copy cannot be taken back without deleting; a move goes back where it came from.
          if (!copy)
            offerUndoMove(
              completed.length === 1
                ? t('已移动“{name}”', { name: filename(completed[0]) })
                : t('已移动 {count} 项', { count: completed.length }),
              completed.map((to, index) => ({ from: operations[index].path, to })),
            );
        }
      }
    });
  }
  function pasteDestination(source: string, folder: string, copy: boolean) {
    const wanted = join(folder, filename(source));
    if (!copy || wanted !== source) return wanted;
    const entry = scan.entries.find((e) => e.path === source),
      name = filename(source);
    const dot = entry?.directory ? -1 : name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name,
      ext = dot > 0 ? name.slice(dot) : '';
    let n = 1;
    while (
      scan.entries.some(
        (e) => e.path.toLowerCase() === join(folder, `${stem} (${n})${ext}`).toLowerCase(),
      )
    )
      n++;
    return join(folder, `${stem} (${n})${ext}`);
  }
  const binding = scan.papers.find((p) => p.path === target || p.notePath === target);
  const pathFrom = (element: EventTarget | null) =>
    element instanceof Element
      ? (element.closest('[data-tree-id]')?.getAttribute('data-tree-id') ?? '')
      : '';
  async function showMenu(path: string, x: number, y: number) {
    await browserLayout({ op: 'hideAll' }).catch(() => {});
    setSelected(path);
    if (!selectedPaths.has(path)) setSelectedPaths(new Set(path ? [path] : []));
    setMenu({
      path,
      x: Math.min(x, window.innerWidth - 215),
      y: Math.min(y, window.innerHeight - 360),
    });
  }
  function command(kind: 'move' | 'relink', path = target) {
    setMenu(null);
    setDialog({ kind, path, value: path });
  }
  /** Names an existing row where it stands in the tree; Enter keeps the name, Esc drops it. */
  function startRename(path = target) {
    setMenu(null);
    const entry = scan.entries.find((e) => e.path === path);
    if (!entry || readOnly || busy) return;
    // The row has to be showing: open the folders above it.
    setCollapsed((current) => {
      const next = new Set(current);
      for (let folder = parent(path); folder; folder = parent(folder)) next.delete(folder);
      return next;
    });
    setDraft({
      id: path,
      kind: entry.directory ? 'folder' : 'file',
      parent: parent(path),
      value: entry.name,
    });
  }
  function startFolder(folder: string) {
    setMenu(null);
    if (readOnly || !scan.root || busy) return;
    if (folder)
      setCollapsed((current) => {
        const next = new Set(current);
        next.delete(folder);
        return next;
      });
    setDraft({ parent: folder, value: '' });
  }
  function commitDraft() {
    if (!draft) return;
    const name = draft.value.trim();
    if (!name) {
      setDraft(null);
      return;
    }
    if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
      setDraft({ ...draft, error: t('名称不能包含 \\ / : * ? " < > |') });
      return;
    }
    const path = join(draft.parent, name);
    if (draft.id && name === filename(draft.id)) {
      setDraft(null);
      return;
    }
    // Renaming only the letter case keeps the same place, so it does not collide with itself.
    if (
      path.toLowerCase() !== draft.id?.toLowerCase() &&
      scan.entries.some((entry) => entry.path.toLowerCase() === path.toLowerCase())
    ) {
      setDraft({ ...draft, error: t('此位置已存在文件或文件夹“{name}”。', { name }) });
      return;
    }
    setDraft(null);
    if (draft.id) {
      void mutate({ op: 'transfer', path: draft.id, destination: path, copy: false });
      return;
    }
    void mutate({ op: 'mkdir', path }).then((success) => {
      if (success && alive.current) {
        setSelected(path);
        setSelectedPaths(new Set([path]));
      }
    });
  }
  const fileEvents = {
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault();
      void showMenu(pathFrom(e.target), e.clientX, e.clientY);
    },
    onDragStart: (e: ReactDragEvent<HTMLElement>) => {
      if (busy || !scan.root) {
        e.preventDefault();
        return;
      }
      const path = pathFrom(e.target);
      drag.current = selectedBundle(path);
      if (!selectedPaths.has(path)) setSelectedPaths(new Set([path]));
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', drag.current.join('\n'));
      e.dataTransfer.setData('application/x-scientify-library', JSON.stringify(drag.current));
    },
    onDragEnd: () => {
      drag.current = [];
      setDropTarget(null);
    },
    onDragOver: (e: ReactDragEvent<HTMLElement>) => {
      if (drag.current.length || e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        const path = pathFrom(e.target);
        const target = scan.entries.find((entry) => entry.path === path);
        setDropTarget(target?.directory ? path : parent(path));
        e.dataTransfer.dropEffect =
          busy || !scan.root ? 'none' : drag.current.length && !e.ctrlKey ? 'move' : 'copy';
      }
    },
    onDragLeave: (e: ReactDragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
    },
    onDrop: (e: ReactDragEvent<HTMLElement>) => {
      e.preventDefault();
      if (readOnly) return;
      setDropTarget(null);
      const dest = pathFrom(e.target);
      const entry = scan.entries.find((v) => v.path === dest);
      const folder = entry?.directory ? dest : parent(dest);
      if (drag.current.length) {
        void transferMany(drag.current, folder, !!(e.ctrlKey || e.metaKey));
        drag.current = [];
      } else if (e.dataTransfer.types.includes('Files')) {
        const files = Array.from(e.dataTransfer.files);
        const hasDirectory = Array.from(e.dataTransfer.items).some(
          (item) => item.webkitGetAsEntry?.()?.isDirectory,
        );
        void importFiles(files, folder, hasDirectory);
      }
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'v'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        const focusPath = pathFrom(e.target) || selected;
        const focusEntry = scan.entries.find((entry) => entry.path === focusPath);
        const pasteFolder = focusEntry?.directory ? focusPath : parent(focusPath);
        if (e.key.toLowerCase() === 'v' && clipboard)
          void transferMany(clipboard.paths, pasteFolder, clipboard.copy);
        else if (focusPath)
          setClipboard({
            paths: selectedBundle(focusPath),
            copy: e.key.toLowerCase() === 'c',
          });
      }
      if (e.key === 'F2') {
        const focusPath = pathFrom(e.target) || selected;
        if (focusPath) {
          e.preventDefault();
          startRename(focusPath);
        }
      }
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = (e.target as HTMLElement).getBoundingClientRect();
        void showMenu(pathFrom(e.target), r.left, r.bottom);
      }
    },
  };
  const resources = (
    <aside
      className={`literature-sidebar${slot ? ' is-docked' : ''}`}
      style={{ '--literature-sidebar-width': `${width}px` } as CSSProperties}
      aria-label={t('本地文献目录')}
    >
      <div className="library-directory">
        <div className="library-root-toolbar" aria-label={t('文献目录工具')}>
          {searchOpen ? (
            <Input
              ref={search}
              className="library-toolbar-search"
              autoFocus
              aria-label={t('搜索文献')}
              placeholder={t('搜索文件名和路径')}
              value={query}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => {
                setQuery(e.target.value);
                if (e.target.value) setCollapsed(new Set());
              }}
              onBlur={() => setSearchOpen(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  e.preventDefault();
                  if (e.key === 'Escape') setQuery('');
                  setSearchOpen(false);
                  requestAnimationFrame(() => {
                    if (!search.current) searchTrigger.current?.focus();
                  });
                }
              }}
            />
          ) : (
            <>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('打开文献文件夹')}
                onClick={() => void choose()}
                disabled={busy}
              >
                <FolderOpen />
              </Button>
              <div className="library-root-title">
                <span className="truncate" title={scan.root ?? ''}>
                  {scan.root ? filename(scan.root) : t('文献库')}
                </span>
              </div>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('搜索文献')}
                ref={searchTrigger}
                onClick={() => {
                  setSearchOpen(true);
                }}
              >
                <Search />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('更多操作')}
                onClick={(e) =>
                  void showMenu(
                    '',
                    e.currentTarget.getBoundingClientRect().left,
                    e.currentTarget.getBoundingClientRect().bottom,
                  )
                }
              >
                <MoreHorizontal />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('新建文件夹')}
                disabled={readOnly || !scan.root || busy}
                onClick={() => startFolder(directory)}
              >
                <FolderPlus />
              </Button>
            </>
          )}
        </div>
        <div
          className={`local-file-tree${dropTarget !== null ? ' is-file-dragging' : ''}`}
          {...fileEvents}
          onClick={(event) => {
            // Clicking empty space clears the selection, so new folders go to the root.
            if ((event.target as Element).closest('[data-tree-id], button, input, a')) return;
            setSelected('');
            setSelectedPaths(new Set());
          }}
        >
          <TreeView
            label={t('项目文献')}
            items={tree}
            draft={
              draft
                ? {
                    ...draft,
                    label: draft.id ? t('名称') : t('文件夹名称'),
                    onChange: (value) => setDraft({ ...draft, value, error: undefined }),
                    onCommit: commitDraft,
                    onCancel: () => setDraft(null),
                  }
                : null
            }
            selectedId={selected}
            selectedIds={selectedPaths}
            onSelectionChange={(paths, active) => {
              setSelectedPaths(paths);
              setSelected(active);
            }}
            dropTargetId={dropTarget}
            collapsed={collapsed}
            onToggle={(id) => {
              setSelected(id);
              setCollapsed((s) => {
                const n = new Set(s);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              });
            }}
            onOpen={(path) => void open(path)}
            onContextMenu={(path, event) => void showMenu(path, event.clientX, event.clientY)}
          />
          {dropTarget !== null && (
            <div className="library-drop-hint">
              {t('复制到 {folder}', {
                folder: dropTarget || filename(scan.root ?? t('文献库')),
              })}
            </div>
          )}
          {!scan.root && (
            <div className="library-unmounted">
              <Button onClick={() => void choose()}>{t('打开文献文件夹')}</Button>
              <p>{t('选择真实目录，PDF 与笔记保存在原位置。')}</p>
            </div>
          )}
          {scan.papers
            .filter((p) => !scan.entries.some((e) => e.path === p.path))
            .map((p) => (
              <div key={p.id} className="missing-paper-row">
                <Button
                  variant="ghost"
                  className="missing-paper"
                  onClick={() => {
                    setDialog({ kind: 'relink', path: p.id, value: p.path });
                  }}
                >
                  {t('重新关联')} · {filename(p.path)}
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  size="sm"
                  aria-label={t('移除失联记录')}
                  title={t('移除失联记录')}
                  onClick={async () => {
                    if (
                      await confirmAction(
                        t('移除“{name}”的失联记录？不会删除仍存在的文件。', {
                          name: filename(p.path),
                        }),
                      )
                    )
                      void mutate({ op: 'pruneMissing', id: p.id });
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
        </div>
      </div>
    </aside>
  );
  // The paper and its note share the area: either may take up to 80% of it. Dragging
  // past 85% closes the page that got small (the paper's tab, or the note pane).
  const area = splitWidth || hostWidth;
  const noteMax = Math.max(MIN_NOTE_WIDTH, Math.round(area * 0.8));
  const noteMin = Math.min(noteMax, Math.max(MIN_NOTE_WIDTH, Math.round(area * 0.2)));
  function resizeNotes(next: number) {
    if (splitClosed.current || !area) return;
    if (next > area * 0.85 && active) {
      splitClosed.current = true;
      void closeTab(active.id).catch((e) => setError(errorMessage(e)));
      setSession((s) => ({ ...s, noteWidth: Math.round(area / 2) }));
      return;
    }
    if (next < area * 0.15) {
      splitClosed.current = true;
      setSession((s) => ({ ...s, showNotes: false }));
      return;
    }
    setSession((s) => ({
      ...s,
      noteWidth: Math.round(Math.min(noteMax, Math.max(noteMin, next))),
    }));
  }
  // Several files selected at once: a folder carries what is in it, a paper its note. The bar
  // keeps the last numbers while it fades out.
  const batch = transferPaths(selectedPaths);
  const batchPdfs = batch.filter((path) => scan.entries.some((e) => e.path === path && e.pdf));
  const batchShown = useRef({ count: 0, pdfs: 0 });
  if (batch.length > 1) batchShown.current = { count: batch.length, pdfs: batchPdfs.length };
  // Every folder a batch may move into, the library folder first; not into itself.
  const batchFolders = [
    { path: '', depth: 0, label: scan.root ? filename(scan.root) : t('文献库') },
    ...scan.entries
      .filter((entry) => entry.directory && !batch.some((path) => isBelowPath(entry.path, path)))
      .sort((a, b) => collator.compare(a.path, b.path))
      .map((entry) => ({
        path: entry.path,
        depth: entry.path.split('/').length,
        label: entry.name,
      })),
  ];
  /** The paper behind a PDF or its note file, opened into the library when it is not yet. */
  async function paperAt(path: string) {
    return (
      scan.papers.find((p) => p.path === path || p.notePath === path) ??
      (await library.open(project.id, path))
    );
  }
  function showNote(path: string) {
    void run(async () => {
      const bound = await paperAt(path);
      setSession((s) => ({
        ...s,
        notes: s.notes.includes(bound.id) ? s.notes : [...s.notes, bound.id],
        activeNote: bound.id,
        showNotes: true,
      }));
      await refresh();
    });
  }
  function showTranslation(path: string) {
    void run(async () => {
      openTranslation((await paperAt(path)).id);
      await refresh();
    });
  }
  async function trashBatch() {
    const paths = batch;
    if (readOnly || paths.length < 2) return;
    if (!(await confirmAction(t('将选中的 {count} 项移入系统回收站？', { count: paths.length }))))
      return;
    let done = 0;
    for (const path of paths) {
      if (!(await mutate({ op: 'delete', path }))) break;
      done++;
    }
    if (done) toast(t('已将 {count} 项移入回收站', { count: done }));
  }
  async function translateBatch() {
    const paths = batchPdfs;
    if (!paths.length) return;
    await run(async () => {
      const papers: LibraryPaper[] = [];
      for (const path of paths)
        papers.push(
          scan.papers.find((p) => p.path === path) ?? (await library.open(project.id, path)),
        );
      // The last one asked for goes first in line, so the others are asked in reverse and
      // the first is left to its own pane.
      for (const other of papers.slice(1).reverse())
        void translator.open(project.id, other.id).catch(() => {});
      openTranslation(papers[0].id);
      await refresh();
      if (papers.length > 1) toast(t('已优先翻译 {count} 篇', { count: papers.length }));
    });
  }
  const droppingInto = (dropTarget ?? directory) || filename(scan.root ?? t('文献库'));
  return (
    <div
      className="literature-studio local-library"
      ref={host}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          setSearchOpen(true);
          requestAnimationFrame(() => search.current?.focus());
        }
      }}
      onDragOver={(e) => {
        if (!readOnly && scan.root && e.dataTransfer.types.includes('Files')) setPageDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPageDrag(false);
      }}
      onDrop={(e) => {
        setPageDrag(false);
        // The tree and the table took their own drops; this one landed elsewhere on the page.
        if (e.defaultPrevented || readOnly || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        const hasDirectory = Array.from(e.dataTransfer.items ?? []).some(
          (item) => item.webkitGetAsEntry?.()?.isDirectory,
        );
        void importFiles(Array.from(e.dataTransfer.files), directory, hasDirectory);
      }}
    >
      {slot ? (viewActive ? createPortal(resources, slot) : null) : resources}
      {importOpen ? (
        <ImportLibrary
          projectId={project.id}
          onClose={() => setImportOpen(false)}
          onDone={() => {
            requestProjectSync(project.id);
            void refresh();
          }}
        />
      ) : null}
      {slot ? null : resize}
      <div className="local-library-center">
        {(error || scan.warnings.length > 0) && (
          <div className="inline-error" role="alert">
            {error ? translateError(error) : scan.warnings.map(translateError).join('\n')}
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('关闭提示')}
              onClick={() => {
                setError('');
                setScan((s) => ({ ...s, warnings: [] }));
              }}
            >
              <X />
            </Button>
          </div>
        )}
        <div className="local-editor-groups" ref={splitArea}>
          <div className="local-reading-group">
            <DocumentTabs
              tabs={[
                { id: HOME, title: t('文献库'), pinned: true, icon: <BookOpen size={14} /> },
                ...session.tabs.map((tab) => ({
                  id: tab.id,
                  title: tab.paperId
                    ? filename(scan.papers.find((p) => p.id === tab.paperId)?.path ?? tab.title)
                    : tab.title,
                })),
              ]}
              activeId={active ? session.active : HOME}
              panelId={panelId}
              newLabel={t('浏览器新页')}
              onContextMenu={(id, position) => {
                const tab = session.tabs.find((t) => t.id === id);
                const path = tab?.paperId
                  ? scan.papers.find((p) => p.id === tab.paperId)?.path
                  : tab?.path;
                if (path) void showMenu(path, position.x, position.y);
              }}
              onSelect={(id) =>
                setSession((s) => {
                  if (id === HOME) return { ...s, active: null };
                  const tab = s.tabs.find((t) => t.id === id);
                  return {
                    ...s,
                    active: id,
                    activeNote:
                      tab?.paperId && s.notes.includes(tab.paperId) ? tab.paperId : s.activeNote,
                  };
                })
              }
              onClose={(id) => void closeTab(id).catch((e) => setError(errorMessage(e)))}
              onReorder={(ids) =>
                setSession((s) => ({
                  ...s,
                  tabs: ids.flatMap((id) => s.tabs.find((tab) => tab.id === id) ?? []),
                }))
              }
              onNew={() => void newWeb()}
            />
            <div className="local-reader" id={panelId} role="tabpanel" aria-label={t('文献呈现区')}>
              {active?.kind === 'recommendations' ? (
                <FeaturePlaceholder feature="recommendations" />
              ) : active?.kind === 'web' ? (
                <BrowserPane
                  key={active.id}
                  id={active.id}
                  initialUrl={active.url}
                  onChanged={(tab) =>
                    setSession((s) => ({
                      ...s,
                      tabs: s.tabs.map((t) =>
                        t.id === tab.id
                          ? { ...t, title: tab.title || tab.url || t.title, url: tab.url || t.url }
                          : t,
                      ),
                    }))
                  }
                />
              ) : active?.kind === 'text' && active.path ? (
                <LocalTextFile
                  key={active.id}
                  library={library}
                  project={project.id}
                  path={active.path}
                  title={active.title}
                  onContext={(value) => {
                    const textContext: WorkContext = {
                      projectId: project.id,
                      workspace: 'literature',
                      title: active.title,
                      resourceId: active.path,
                      path: active.path,
                      text: value,
                    };
                    setSelection(textContext);
                    changed.current(textContext);
                  }}
                />
              ) : paper ? (
                <Suspense fallback={<p>{t('正在打开阅读器…')}</p>}>
                  <PdfReader
                    key={`${paper.id}:${paper.fingerprint}`}
                    assetId={paper.id}
                    paperId={paper.id}
                    title={filename(paper.path)}
                    projectId={project.id}
                    backend={reader}
                    compact
                    record={recordStore}
                    readOnly={readOnly}
                    onQuote={(text, page) => void quote(paper.id, text, page)}
                    onContext={(value) => {
                      // Name the open PDF so the agent can read the whole paper, not just this page.
                      const next = { ...value, paperPath: paper.path };
                      setSelection(next);
                      changed.current(next);
                    }}
                    onTool={() =>
                      setSession((s) => ({
                        ...s,
                        notes: s.notes.includes(paper.id) ? s.notes : [...s.notes, paper.id],
                        activeNote: paper.id,
                        showNotes: true,
                      }))
                    }
                  />
                </Suspense>
              ) : (
                <LibraryTable
                  root={scan.root}
                  entries={scan.entries}
                  papers={scan.papers}
                  folder={directory}
                  query={query}
                  selected={selected}
                  selectedPaths={selectedPaths}
                  busy={busy}
                  readOnly={readOnly}
                  importing={importProgress}
                  onSelect={(path) => {
                    setSelected(path);
                    setSelectedPaths(new Set([path]));
                  }}
                  onSelectMany={(paths, active) => {
                    setSelectedPaths(paths);
                    setSelected(active);
                  }}
                  onOpen={(path) => void open(path)}
                  onNote={(path) => showNote(path)}
                  onTranslate={(path) => showTranslation(path)}
                  onMenu={(path, x, y) => void showMenu(path, x, y)}
                  onChoose={() => void choose()}
                  onImport={(files) => void importFiles(files, directory)}
                  onImportLibrary={readOnly ? undefined : () => setImportOpen(true)}
                  references={references}
                  fileEvents={fileEvents}
                />
              )}
            </div>
          </div>
          {session.showNotes && session.notes.length > 0 && (
            <>
              <ResizeHandle
                value={Math.min(session.noteWidth, noteMax)}
                min={0}
                max={Math.max(noteMax, area)}
                side="right"
                label={t('调整论文笔记宽度')}
                onChange={resizeNotes}
                onEnd={() => {
                  splitClosed.current = false;
                }}
              />
              <div
                className="local-note-group"
                inert={busy}
                style={{ width: Math.min(session.noteWidth, noteMax) }}
              >
                <DocumentTabs
                  tabs={session.notes.map((id) => {
                    const name = filename(
                      scan.papers.find((p) => p.id === paperOfTab(id))?.path ?? t('论文笔记'),
                    );
                    const bound = scan.papers.find((p) => p.id === paperOfTab(id));
                    return {
                      id,
                      title: isTranslationTab(id) ? t('译文 · {name}', { name }) : name,
                      ...(isTranslationTab(id)
                        ? {
                            icon: (
                              <TranslationIcon
                                status={bound ? translationStatus[bound.fingerprint] : undefined}
                              />
                            ),
                          }
                        : {}),
                    };
                  })}
                  activeId={session.activeNote}
                  label={t('论文笔记标签')}
                  panelId={notePanel}
                  onSelect={(activeNote) => setSession((s) => ({ ...s, activeNote }))}
                  onClose={(id) => void closeNote(id)}
                />
                <div
                  id={notePanel}
                  className="local-note-body"
                  role="tabpanel"
                  aria-label={t('论文笔记')}
                >
                  {session.activeNote && isTranslationTab(session.activeNote) ? (
                    <PaperTranslation
                      key={session.activeNote}
                      projectId={project.id}
                      paper={scan.papers.find((p) => p.id === paperOfTab(session.activeNote!))}
                      title={filename(
                        scan.papers.find((p) => p.id === paperOfTab(session.activeNote!))?.path ??
                          '',
                      ).replace(/\.pdf$/i, '')}
                      onContext={(value) => {
                        setSelection(value);
                        changed.current(value);
                      }}
                    />
                  ) : session.activeNote ? (
                    <PaperNotes
                      readOnly={readOnly}
                      key={session.activeNote}
                      library={library}
                      project={project.id}
                      id={session.activeNote}
                      paper={scan.papers.find((p) => p.id === session.activeNote)}
                      selection={selection}
                      onPage={(page) => openPaperPage(session.activeNote!, page)}
                    />
                  ) : null}
                </div>
              </div>
            </>
          )}
        </div>
        <BatchBar
          open={batch.length > 1}
          count={batchShown.current.count}
          translatable={batchShown.current.pdfs}
          busy={busy}
          readOnly={readOnly}
          moving={!!moveMenu}
          onMove={(trigger) => {
            const box = trigger.getBoundingClientRect();
            void browserLayout({ op: 'hideAll' }).catch(() => {});
            setMoveMenu({ x: box.left, y: box.top - 6, trigger });
          }}
          onTranslate={() => void translateBatch()}
          onTrash={() => void trashBatch()}
          onClear={() => {
            setSelectedPaths(new Set(selected ? [selected] : []));
          }}
        />
      </div>
      <Menu
        anchor={moveMenu ? { ...moveMenu, placement: 'top' } : null}
        label={t('移动到')}
        onClose={() => setMoveMenu(null)}
      >
        {batchFolders.map((folder) => (
          <Button
            key={folder.path || '/'}
            role="menuitem"
            style={{ paddingInlineStart: 8 + Math.min(folder.depth, 4) * 12 }}
            onClick={() => void transferMany(batch, folder.path, false)}
          >
            <Folder size={14} />
            {folder.label}
          </Button>
        ))}
      </Menu>
      <Menu
        anchor={
          menu
            ? {
                x: menu.x,
                y: menu.y,
                trigger: host.current?.querySelector<HTMLElement>(
                  '[role="treeitem"][tabindex="0"]',
                ),
              }
            : null
        }
        label={t('文献操作')}
        onClose={() => setMenu(null)}
      >
        <Button disabled={readOnly} role="menuitem" onClick={() => startFolder(targetFolder)}>
          {t('新建文件夹')}
        </Button>
        {target && (
          <>
            <Button disabled={readOnly} role="menuitem" onClick={() => startRename()}>
              {t('重命名')}
            </Button>
            <Button
              role="menuitem"
              disabled={readOnly}
              onClick={async () => {
                setClipboard({ paths: selectedBundle(target), copy: false });
                setMenu(null);
              }}
            >
              {t('剪切')}
            </Button>
            <Button
              role="menuitem"
              onClick={async () => {
                setClipboard({ paths: selectedBundle(target), copy: true });
                setMenu(null);
              }}
            >
              {t('复制')}
            </Button>
            <Button disabled={readOnly} role="menuitem" onClick={() => command('move')}>
              {t('移动到')}
            </Button>
          </>
        )}
        <Button
          role="menuitem"
          disabled={readOnly || !clipboard || !scan.root}
          onClick={async () => {
            if (clipboard) void transferMany(clipboard.paths, targetFolder, clipboard.copy);
            setMenu(null);
          }}
        >
          {t('粘贴')}
        </Button>
        {(binding || targetEntry?.pdf) && (
          <Button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              showNote(target);
            }}
          >
            <NotebookPen />
            {t('打开论文笔记')}
          </Button>
        )}
        {(binding || targetEntry?.pdf) && (
          <Button
            role="menuitem"
            onClick={() => {
              setMenu(null);
              showTranslation(target);
            }}
          >
            <Languages />
            {t('全文翻译')}
          </Button>
        )}
        <Button
          role="menuitem"
          disabled={!scan.root}
          onClick={async () => {
            void library
              .external(project.id, target, false)
              .catch((e) => setError(errorMessage(e)));
            setMenu(null);
          }}
        >
          {t('在文件管理器中显示')}
        </Button>
        {target && (
          <Button
            role="menuitem"
            disabled={readOnly}
            onClick={async () => {
              setMenu(null);
              if (
                await confirmAction(
                  targetEntry?.directory
                    ? t('将文件夹“{name}”及其全部内容、关联笔记移入系统回收站？', {
                        name: filename(target),
                      })
                    : targetEntry?.pdf
                      ? t('将“{name}”及对应笔记移入系统回收站？', { name: filename(target) })
                      : t('将文件“{name}”移入系统回收站？', { name: filename(target) }),
                )
              )
                void mutate({ op: 'delete', path: target });
            }}
          >
            {t('移入回收站')}
          </Button>
        )}
        <Button
          role="menuitemcheckbox"
          aria-checked={showNotes}
          onClick={async () => {
            setShowNotes(!showNotes);
            setMenu(null);
          }}
        >
          {t('显示笔记文件')}
        </Button>
        <Button
          role="menuitem"
          disabled={!scan.root}
          onClick={async () => {
            setMenu(null);
            if (await confirmAction(t('解除目录关联不会删除文件，是否继续？')))
              void run(async () => {
                protect();
                setScan(await library.command(project.id, { op: 'detach' }));
                invalidateProjectFileSessions(noteFiles(library), project.id);
                for (const tab of currentSession.current.tabs)
                  if (tab.kind === 'web') await browserCommand({ op: 'close', id: tab.id });
                setSession(emptyLocalSession());
                setSelected('');
                setSelectedPaths(new Set());
                setClipboard(null);
              });
          }}
        >
          {t('解除目录关联')}
        </Button>
      </Menu>
      {dialog && (
        <Modal
          title={t({ move: '移动到', relink: '重新关联' }[dialog.kind])}
          onClose={() => setDialog(null)}
          busy={busy}
        >
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const path = dialog.value;
              const operation: LibraryOperation =
                dialog.kind === 'relink'
                  ? { op: 'relink', id: dialog.path, path }
                  : { op: 'transfer', path: dialog.path, destination: path, copy: false };
              void mutate(operation).then((success) => {
                if (success && alive.current) setDialog(null);
              });
            }}
          >
            <Input
              aria-label={t('相对路径')}
              value={dialog.value}
              autoFocus
              onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
              disabled={busy}
            />
            {error && <p role="alert">{translateError(error)}</p>}
            <Button type="submit" disabled={busy || !dialog.value.trim()}>
              {t('保存')}
            </Button>
          </form>
        </Modal>
      )}
      <div className="library-drop-overlay" data-open={pageDrag} aria-hidden="true">
        <div className="library-drop-card">
          <Upload />
          <strong>{t('松开导入')}</strong>
          <small>{t('导入到 {folder}', { folder: droppingInto })}</small>
        </div>
      </div>
    </div>
  );
}

function LocalTextFile({
  library,
  project,
  path,
  title,
  onContext,
}: {
  library: LibraryBackend;
  project: string;
  path: string;
  title: string;
  onContext: (text: string) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const onContextRef = useRef(onContext);
  onContextRef.current = onContext;
  const markdown = /\.(md|markdown|mdown)$/i.test(path);
  const load = useCallback(async () => {
    const ticket = ++generation.current;
    if (!library.readFile) {
      setError(t('当前版本不支持在文献区读取此文件。'));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const file = await library.readFile(project, path);
      if (ticket !== generation.current) return;
      setContent(file.content);
      onContextRef.current(file.content.slice(0, 24000));
    } catch (reason) {
      if (ticket !== generation.current) return;
      setError(errorMessage(reason));
      setContent(null);
    } finally {
      if (ticket === generation.current) setLoading(false);
    }
  }, [library, path, project]);
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
    };
  }, [load]);
  return (
    <div className="local-text-file">
      <div className="local-text-toolbar">
        <FileText size={14} />
        <span className="truncate" title={path}>
          {title}
        </span>
        <span className="sf-spacer" />
        <Button
          variant="ghost"
          iconOnly
          aria-label={t('重新读取文件')}
          title={t('重新读取文件')}
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            void library
              .external?.(project, path, true)
              .catch((reason) => setError(errorMessage(reason)))
          }
        >
          {t('在外部程序打开')}
        </Button>
      </div>
      {loading ? (
        <div className="local-text-state">{t('正在读取文件…')}</div>
      ) : error ? (
        <div className="local-text-state" role="alert">
          {translateError(error)}
        </div>
      ) : content === null ? (
        <div className="local-text-state">{t('没有可显示的内容。')}</div>
      ) : markdown ? (
        <div className="local-text-preview">
          <TextMarkdownPreview content={content} />
        </div>
      ) : (
        <pre className="local-text-raw">{content}</pre>
      )}
      {content !== null && !loading ? (
        <div className="local-text-footer">
          <span>{markdown ? 'Markdown' : t('纯文本')}</span>
          <span>UTF-8</span>
          <span>{t('{count} 行', { count: content.split('\n').length })}</span>
          <span className="sf-spacer" />
          <span>{t('只读预览')}</span>
        </div>
      ) : null}
    </div>
  );
}
