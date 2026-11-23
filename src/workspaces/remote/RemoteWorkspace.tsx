import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  ChevronsDownUp,
  ChevronUp,
  ChevronDown,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  KeyRound,
  Plug,
  RefreshCw,
  Server,
  SquareTerminal,
  Unplug,
  X,
} from 'lucide-react';
import { Button, Input } from '../../components/primitives';
import { Menu, menuAnchor, type MenuAnchor } from '../../components/primitives/Menu';
import { Modal } from '../../components/Modal';
import { Collapse, Spinner, StateLabel } from '../../components/feedback';
import { confirmAction } from '../../components/prompts';
import { DocumentTabs } from '../../components/workspace/DocumentTabs';
import { PanelSash } from '../../components/workspace/PanelSash';
import { TreeView, type TreeItem } from '../../components/workspace/TreeView';
import { useActiveView } from '../../components/workspace/ViewTransition';
import { useSidebarSlot } from '../../shell/Sidebar';
import { CodeEditor } from '../../editor/CodeEditor';
import { getFileRuntime, getFileSession, type FileSession } from '../../editor/sessions';
import { t } from '../../i18n';
import type { Project } from '../../domain/workspace';
import type { WorkContext } from '../../domain/context';
import type { FileBackend } from '../../platform/research';
import { canEditProject } from '../../platform/collaboration';
import { developmentStore } from '../experiments/development';
import {
  disconnected,
  expandHome,
  joinPath,
  nameOf,
  needsPassword,
  parentOf,
  remote,
  remoteMessage,
  type RemoteApi,
  type RemoteConnection,
  type RemoteEntry,
  type RemoteHost,
} from '../../platform/remote';
import '../experiments/experiments.css';
import '../experiments/workbench.css';
import '../files/files.css';
import './remote.css';

const TerminalPanel = lazy(() =>
  import('../experiments/TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);

/** One project's connection, kept while the page is away so coming back finds it as left. */
type Place = {
  connection: RemoteConnection;
  /** Reads and writes through whichever connection the place has now, so open buffers survive a reconnect. */
  backend: FileBackend;
  /** The line dropped; everything stays on screen until the user reconnects. */
  lost?: boolean;
  folder: string;
  tabs: string[];
  active: string | null;
  expanded: string[];
};
const places = createStore<Record<string, Place | undefined>>(() => ({}));
const RECENT_KEY = 'capsio.remote.recent';
const PANEL_KEY = 'capsio.remote.panelHeight';

type Recent = { target: string; folder?: string };
function recentHosts(): Recent[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((item) => typeof item?.target === 'string') : [];
  } catch {
    return [];
  }
}
function remember(target: string, folder?: string) {
  const list = [
    { target, folder },
    ...recentHosts().filter((item) => item.target !== target),
  ].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* Recent hosts are a convenience. */
  }
}

function stableFiles(projectId: string, first: RemoteConnection, api: RemoteApi): FileBackend {
  const id = () => places.getState()[projectId]?.connection.id ?? first.id;
  return {
    readFile: (_project, path) => api.read(id(), path),
    writeFile: (_project, path, content, expected) => api.write(id(), path, content, expected),
  };
}

function patch(projectId: string, change: Partial<Place> | null) {
  places.setState((all) => {
    const current = all[projectId];
    if (change === null) return { ...all, [projectId]: undefined };
    if (!current) return all;
    return { ...all, [projectId]: { ...current, ...change } };
  });
}

/** Hosts from `~/.ssh/config` and the ones typed before, to connect with one click. */
function HostList({
  hosts,
  recent,
  busy,
  connecting,
  onPick,
}: {
  hosts: RemoteHost[];
  recent: Recent[];
  busy: boolean;
  connecting: string | null;
  onPick(target: string): void;
}) {
  const named = new Set(hosts.map((host) => host.alias));
  const typed = recent.filter((item) => !named.has(item.target));
  return (
    <>
      {hosts.length ? (
        <section className="remote-hosts">
          <h3>{t('SSH 配置里的主机')}</h3>
          {hosts.map((host) => (
            <button
              key={host.alias}
              type="button"
              className="remote-host"
              disabled={busy}
              onClick={() => onPick(host.alias)}
            >
              {connecting === host.alias ? (
                <span className="remote-dot" data-state="connecting" aria-hidden />
              ) : (
                <Server size={15} />
              )}
              <span>
                <strong>{host.alias}</strong>
                <small>
                  {[host.user, host.hostName].filter(Boolean).join('@')}
                  {host.port && host.port !== '22' ? `:${host.port}` : ''}
                </small>
              </span>
            </button>
          ))}
        </section>
      ) : null}
      {typed.length ? (
        <section className="remote-hosts">
          <h3>{t('最近连接')}</h3>
          {typed.map((item) => (
            <button
              key={item.target}
              type="button"
              className="remote-host"
              disabled={busy}
              onClick={() => onPick(item.target)}
            >
              {connecting === item.target ? (
                <span className="remote-dot" data-state="connecting" aria-hidden />
              ) : (
                <Server size={15} />
              )}
              <span>
                <strong>{item.target}</strong>
                {item.folder ? <small>{item.folder}</small> : null}
              </span>
            </button>
          ))}
        </section>
      ) : null}
    </>
  );
}

/** Pick a folder on the host: walk into folders, go up, or type a path. */
function FolderPicker({
  api,
  connection,
  start,
  onPick,
  onClose,
}: {
  api: RemoteApi;
  connection: RemoteConnection;
  start: string;
  onPick(folder: string): void;
  onClose(): void;
}) {
  const [path, setPath] = useState(start);
  const [typed, setTyped] = useState(start);
  const [folders, setFolders] = useState<RemoteEntry[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setFolders(null);
    api
      .list(connection.id, path)
      .then((entries) => live && setFolders(entries.filter((e) => e.kind === 'directory')))
      .catch((reason) => live && setError(remoteMessage(reason)));
    return () => {
      live = false;
    };
  }, [api, connection.id, path]);
  async function go(next: string) {
    setError('');
    try {
      const resolved = await api.resolve(connection.id, expandHome(next.trim(), connection.home));
      setPath(resolved);
      setTyped(resolved);
    } catch (reason) {
      setError(remoteMessage(reason));
    }
  }
  return (
    <Modal title={t('打开文件夹')} className="remote-folder-dialog" onClose={onClose}>
      <form
        className="remote-folder-path"
        onSubmit={(event) => {
          event.preventDefault();
          void go(typed);
        }}
      >
        <Input
          aria-label={t('文件夹路径')}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <Button type="submit">{t('前往')}</Button>
      </form>
      <ul className="remote-folder-list" aria-label={t('文件夹')}>
        {path !== '/' ? (
          <li>
            <button type="button" onClick={() => void go(parentOf(path))}>
              <FolderOpen size={14} />
              ..
            </button>
          </li>
        ) : null}
        {folders === null ? (
          <li className="remote-muted">{t('正在读取…')}</li>
        ) : (
          folders.map((folder) => (
            <li key={folder.path}>
              <button
                type="button"
                onDoubleClick={() => void go(folder.path)}
                onClick={() => setTyped(folder.path)}
              >
                <FolderOpen size={14} />
                {folder.name}
              </button>
            </li>
          ))
        )}
      </ul>
      {error ? (
        <p role="alert" className="error-text remote-folder-error">
          {error}
        </p>
      ) : null}
      <footer className="dialog-footer remote-folder-footer">
        <span className="remote-muted">{path}</span>
        <Button
          variant="primary"
          onClick={() => onPick(typed.trim() === path ? path : typed.trim())}
        >
          {t('打开')}
        </Button>
      </footer>
    </Modal>
  );
}

function RemoteEditor({
  session,
  readOnly,
  onSelection,
}: {
  session: FileSession;
  readOnly: boolean;
  onSelection(text: string): void;
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    void session.load();
  }, [session]);
  if (snapshot.phase === 'loading' || snapshot.phase === 'idle')
    return <p className="remote-muted remote-editor-state">{t('正在读取…')}</p>;
  if (snapshot.phase === 'error' && snapshot.content === '')
    return (
      <p role="alert" className="remote-editor-state error-text">
        {remoteMessage(snapshot.error)}
      </p>
    );
  return (
    <div className="remote-editor">
      {snapshot.error ? (
        <p role="alert" className="error-text remote-save-error">
          {remoteMessage(snapshot.error)}
        </p>
      ) : null}
      <CodeEditor session={session} readOnly={readOnly} onSelection={onSelection} />
    </div>
  );
}

/**
 * The cloud host page, like VS Code's Remote-SSH: connect to a host, browse a
 * folder on it in the sidebar, edit its files and open a terminal there.
 */
export function RemoteWorkspace({
  project,
  onContext,
  api = remote,
}: {
  project: Project;
  onContext(context: WorkContext): void;
  api?: RemoteApi;
}) {
  const slot = useSidebarSlot();
  const viewActive = useActiveView();
  const place = useStore(places, (all) => all[project.id]);
  const readOnly = !canEditProject(project, 'code');
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [recent, setRecent] = useState(recentHosts);
  const [target, setTarget] = useState(() => recentHosts()[0]?.target ?? '');
  const [password, setPassword] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [entries, setEntries] = useState<Record<string, RemoteEntry[] | 'loading' | undefined>>({});
  const [selected, setSelected] = useState<string | null>(null);
  // A new file or folder is named in place in the tree, as in the experiments page.
  const [draft, setDraft] = useState<{
    /** Set when an existing row is being renamed in place. */
    id?: string;
    kind: 'file' | 'folder';
    parent: string;
    value: string;
    error?: string;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectPassword, setReconnectPassword] = useState<string | null>(null);
  useEffect(() => setDraft(null), [place?.connection?.id, place?.folder]);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; path: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelHeight, setPanelHeight] = useState(
    () => Number(localStorage.getItem(PANEL_KEY)) || 240,
  );
  const [terminalId, setTerminalId] = useState('');
  const area = useRef<HTMLDivElement>(null);
  const connection = place?.connection;
  const allTerminals = useStore(developmentStore, (s) => s.terminals);
  const terminals = allTerminals.filter(
    (info) => connection && info.experimentId === `remote:${connection.id}`,
  );
  const backend = place?.backend ?? null;
  const runtime = backend ? getFileRuntime(backend) : null;
  useSyncExternalStore(
    (listener) => {
      runtime?.listeners.add(listener);
      return () => runtime?.listeners.delete(listener);
    },
    () => runtime?.revision ?? 0,
  );
  useEffect(() => {
    void api
      .hosts()
      .then(setHosts)
      .catch(() => {});
  }, [api]);

  /** A call that finds the line dropped keeps the page as it is and offers to reconnect. */
  function fail(reason: unknown) {
    if (disconnected(reason) && connection) {
      patch(project.id, { lost: true });
      return;
    }
    setError(remoteMessage(reason));
  }

  /** Connects to the same host again, keeping the open files and the tree. */
  async function reconnect(secret?: string) {
    if (!place || reconnecting) return;
    setReconnecting(true);
    setError('');
    try {
      const made = await api.connect(place.connection.target, secret || undefined);
      patch(project.id, { connection: made, lost: false });
      setReconnectPassword(null);
    } catch (reason) {
      if (needsPassword(reason) && !secret) setReconnectPassword('');
      else setError(remoteMessage(reason));
    } finally {
      setReconnecting(false);
    }
  }

  /** `quiet`: a background refresh drops a folder that is gone without an error message;
   *  a lost connection still shows its banner. */
  async function load(path: string, quiet = false) {
    if (!connection) return;
    setEntries((all) => ({ ...all, [path]: all[path] ?? 'loading' }));
    try {
      const list = await api.list(connection.id, path);
      setEntries((all) => ({ ...all, [path]: list }));
    } catch (reason) {
      // A folder already listed stays on screen when reading it again fails.
      setEntries((all) => ({ ...all, [path]: Array.isArray(all[path]) ? all[path] : [] }));
      if (!quiet || disconnected(reason)) fail(reason);
    }
  }
  useEffect(() => {
    if (!place) return;
    setEntries({});
    void load(place.folder);
    for (const path of place.expanded) void load(path);
    // A new connection or folder reads afresh; expanding reads on its own.
  }, [place?.connection.id, place?.folder]);
  // The server changes behind the tree (terminal commands, other tools). Open folders are read
  // again when the window comes back, when the pointer returns to the tree and every 15 s while
  // the page is visible; each listing is an SSH round trip, so not more often than every 3 s.
  const lastRefresh = useRef(0);
  const refreshTree = useRef(() => {});
  refreshTree.current = () => {
    if (!place || !viewActive || document.hidden || Date.now() - lastRefresh.current < 3000) return;
    lastRefresh.current = Date.now();
    void load(place.folder, true);
    for (const path of place.expanded) if (entries[path] !== undefined) void load(path, true);
  };
  useEffect(() => {
    if (!place || !viewActive) return;
    const refresh = () => refreshTree.current();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [place?.connection.id, place?.folder, viewActive]);

  async function connect(event?: FormEvent, chosen = target, secret?: string) {
    event?.preventDefault();
    const destination = chosen.trim();
    if (!destination) return;
    setError('');
    setConnecting(destination);
    try {
      const made = await api.connect(destination, secret || undefined);
      const last = recentHosts().find((item) => item.target === destination)?.folder;
      let folder = made.home;
      if (last) folder = await api.resolve(made.id, last).catch(() => made.home);
      places.setState((all) => ({
        ...all,
        [project.id]: {
          connection: made,
          backend: stableFiles(project.id, made, api),
          folder,
          tabs: [],
          active: null,
          expanded: [],
        },
      }));
      remember(destination, folder);
      setRecent(recentHosts());
      setAsking(null);
      setPassword('');
    } catch (reason) {
      if (needsPassword(reason) && !secret) {
        setAsking(destination);
      } else {
        setError(remoteMessage(reason));
      }
    } finally {
      setConnecting(null);
    }
  }

  function openFolder(folder: string) {
    if (!connection) return;
    patch(project.id, { folder, expanded: [] });
    remember(connection.target, folder);
    setRecent(recentHosts());
    setPicking(false);
  }

  function openFile(path: string) {
    if (!place) return;
    patch(project.id, {
      tabs: place.tabs.includes(path) ? place.tabs : [...place.tabs, path],
      active: path,
    });
  }

  async function closeTab(path: string) {
    if (!place || !backend) return;
    const session = getFileSession(backend, project.id, path);
    if (
      session.getSnapshot().dirty &&
      !(await confirmAction(t('放弃对 {name} 的修改？', { name: nameOf(path) })))
    )
      return;
    getFileRuntime(backend).sessions.delete(JSON.stringify([project.id, path, '']));
    const tabs = place.tabs.filter((tab) => tab !== path);
    patch(project.id, {
      tabs,
      active: place.active === path ? (tabs.at(-1) ?? null) : place.active,
    });
  }

  function toggle(path: string) {
    if (!place) return;
    const open = place.expanded.includes(path);
    patch(project.id, {
      expanded: open ? place.expanded.filter((p) => p !== path) : [...place.expanded, path],
    });
    if (!open && entries[path] === undefined) void load(path);
  }

  /** New items go into the selected folder, or the selected file's folder. */
  function targetFolder() {
    if (!place) return '';
    if (!selected) return place.folder;
    const entry = Object.values(entries)
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .find((item) => item.path === selected);
    return entry?.kind === 'directory' ? entry.path : parentOf(selected);
  }

  function make(directory: boolean, folder = targetFolder()) {
    if (!connection || !place || creating) return;
    if (folder !== place.folder && !place.expanded.includes(folder)) {
      patch(project.id, { expanded: [...place.expanded, folder] });
      if (entries[folder] === undefined) void load(folder);
    }
    setDraft({ kind: directory ? 'folder' : 'file', parent: folder, value: '' });
  }

  async function commitDraft() {
    if (!connection || !place || !draft || creating) return;
    if (draft.id) return commitRename({ ...draft, id: draft.id });
    const name = draft.value.trim();
    if (!name) return setDraft(null);
    if (name.includes('/') || name === '.' || name === '..')
      return setDraft({ ...draft, error: t('名称里不能有 /。') });
    const siblings = entries[draft.parent];
    if (Array.isArray(siblings) && siblings.some((item) => nameOf(item.path) === name))
      return setDraft({ ...draft, error: t('此位置已存在文件或文件夹“{name}”。', { name }) });
    const path = joinPath(draft.parent, name);
    setCreating(true);
    try {
      await api.create(connection.id, path, draft.kind === 'folder');
      await load(draft.parent);
      setDraft(null);
      if (draft.kind === 'file') openFile(path);
      setSelected(path);
    } catch (reason) {
      if (disconnected(reason)) {
        setDraft(null);
        fail(reason);
      } else setDraft({ ...draft, error: remoteMessage(reason) });
    } finally {
      setCreating(false);
    }
  }

  /** Renaming happens in the row itself, like a new file does. */
  function renameItem(path: string) {
    if (!connection || creating) return;
    const entry = Object.values(entries)
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .find((item) => item.path === path);
    setDraft({
      id: path,
      kind: entry?.kind === 'directory' ? 'folder' : 'file',
      parent: parentOf(path),
      value: nameOf(path),
    });
  }

  async function commitRename(current: NonNullable<typeof draft> & { id: string }) {
    if (!connection || !place) return;
    const path = current.id;
    const name = current.value.trim();
    if (!name || name === nameOf(path)) return setDraft(null);
    if (name.includes('/') || name === '.' || name === '..')
      return setDraft({ ...current, error: t('名称里不能有 /。') });
    const siblings = entries[current.parent];
    if (Array.isArray(siblings) && siblings.some((item) => nameOf(item.path) === name))
      return setDraft({ ...current, error: t('此位置已存在文件或文件夹“{name}”。', { name }) });
    const next = joinPath(current.parent, name);
    // Open tabs and expanded folders inside a renamed folder follow it.
    const moved = (item: string) =>
      item === path ? next : item.startsWith(`${path}/`) ? next + item.slice(path.length) : item;
    setCreating(true);
    try {
      await api.rename(connection.id, path, next);
      await load(current.parent);
      setDraft(null);
      patch(project.id, {
        tabs: place.tabs.map(moved),
        active: place.active ? moved(place.active) : place.active,
        expanded: place.expanded.map(moved),
      });
      setSelected(next);
    } catch (reason) {
      if (disconnected(reason)) {
        setDraft(null);
        fail(reason);
      } else setDraft({ ...current, error: remoteMessage(reason) });
    } finally {
      setCreating(false);
    }
  }

  async function deleteItem(path: string) {
    if (!connection || !place) return;
    if (!(await confirmAction(t('从云主机上删除 {name}？不能撤销。', { name: nameOf(path) }))))
      return;
    try {
      await api.delete(connection.id, path);
      await load(parentOf(path));
      const gone = (tab: string) => tab === path || tab.startsWith(`${path}/`);
      const tabs = place.tabs.filter((tab) => !gone(tab));
      patch(project.id, {
        tabs,
        active: place.active && gone(place.active) ? (tabs.at(-1) ?? null) : place.active,
      });
    } catch (reason) {
      fail(reason);
    }
  }

  async function newTerminal(path?: string) {
    if (!connection || !place) return null;
    try {
      const info = await api.terminal(project.id, connection.id, path ?? place.folder);
      developmentStore.setState((data) => ({
        terminals: [...data.terminals.filter((item) => item.id !== info.id), info],
      }));
      setTerminalId(info.id);
      setPanelOpen(true);
      return info;
    } catch (reason) {
      fail(reason);
      return null;
    }
  }

  // The AI sees the open file on the host.
  useEffect(() => {
    if (!viewActive || !connection) return;
    onContext({
      projectId: project.id,
      workspace: 'remote',
      title: place?.active ? nameOf(place.active) : connection.target,
      resourceId: place?.active ?? undefined,
      path: place?.active ?? undefined,
    });
  }, [viewActive, connection?.id, place?.active]);

  const items = (path: string): TreeItem[] => {
    const list = entries[path];
    // A double slash never names a real entry.
    if (list === 'loading') return [{ id: `${path}//loading`, label: t('正在读取…') }];
    return (list ?? []).map((entry) => ({
      id: entry.path,
      label: entry.name,
      tooltip: entry.link ? t('链接') : undefined,
      children: entry.kind === 'directory' ? items(entry.path) : undefined,
    }));
  };
  const expanded = new Set(place?.expanded ?? []);
  // Every folder the tree knows of that is not open.
  const collapsed: ReadonlySet<string> = new Set(
    Object.values(entries)
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .filter((entry) => entry.kind === 'directory' && !expanded.has(entry.path))
      .map((entry) => entry.path),
  );

  const hostsBlock = (
    <HostList
      hosts={hosts}
      recent={recent}
      busy={!!connecting}
      connecting={connecting}
      onPick={(chosen) => {
        setTarget(chosen);
        void connect(undefined, chosen);
      }}
    />
  );

  const side: ReactNode = (
    <div className="sf-ide-side remote-side">
      <div className="sf-ide-view-title">{connection ? t('资源管理器') : t('云主机')}</div>
      {place && connection ? (
        <>
          <div className="sf-file-resources">
            <div className="sf-resource-heading">
              <span title={place.folder}>{nameOf(place.folder)}</span>
              {!readOnly ? (
                <>
                  <Button
                    variant="ghost"
                    iconOnly
                    aria-label={t('新建文件')}
                    tooltip={t('新建文件…')}
                    onClick={() => void make(false)}
                  >
                    <FilePlus2 size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    iconOnly
                    aria-label={t('新建文件夹')}
                    tooltip={t('新建文件夹…')}
                    onClick={() => void make(true)}
                  >
                    <FolderPlus size={13} />
                  </Button>
                </>
              ) : null}
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('打开文件夹')}
                tooltip={t('打开文件夹…')}
                onClick={() => setPicking(true)}
              >
                <FolderOpen size={13} />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('折叠所有文件夹')}
                onClick={() => patch(project.id, { expanded: [] })}
              >
                <ChevronsDownUp size={13} />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label={t('刷新')}
                onClick={() => {
                  void load(place.folder);
                  for (const path of place.expanded) void load(path);
                }}
              >
                <RefreshCw size={13} />
              </Button>
            </div>
            <div
              className="sf-resource-tree"
              onPointerEnter={() => refreshTree.current()}
              onClick={(event) => {
                if (!(event.target as Element).closest('[data-tree-id], button')) setSelected(null);
              }}
            >
              {entries[place.folder] === 'loading' || entries[place.folder] === undefined ? (
                <p>{t('正在读取…')}</p>
              ) : items(place.folder).length || draft ? (
                <TreeView
                  label={t('云主机文件')}
                  items={items(place.folder)}
                  draft={
                    draft
                      ? {
                          ...draft,
                          // The tree's top level has no parent id.
                          parent: draft.parent === place.folder ? '' : draft.parent,
                          label: t(draft.kind === 'file' ? '文件名称' : '文件夹名称'),
                          onChange: (value) => setDraft({ ...draft, value, error: undefined }),
                          onCommit: () => void commitDraft(),
                          onCancel: () => setDraft(null),
                        }
                      : null
                  }
                  selectedId={selected ?? place.active}
                  collapsed={collapsed}
                  onToggle={toggle}
                  onOpen={(id) => {
                    setSelected(id);
                    const entry = Object.values(entries)
                      .flatMap((list) => (Array.isArray(list) ? list : []))
                      .find((item) => item.path === id);
                    if (!entry) return;
                    if (entry.kind === 'directory') toggle(id);
                    else openFile(id);
                  }}
                  onContextMenu={(id, event) => {
                    event.preventDefault();
                    setSelected(id);
                    setMenu({ anchor: menuAnchor(event), path: id });
                  }}
                />
              ) : (
                <p>{t('这个文件夹是空的')}</p>
              )}
            </div>
          </div>
          <div className="remote-host-bar">
            <span
              className="remote-dot"
              data-state={place.lost ? (reconnecting ? 'connecting' : 'lost') : 'connected'}
              aria-hidden
            />
            <span title={connection.target}>SSH: {connection.target}</span>
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('断开连接')}
              tooltip={t('断开连接')}
              onClick={() => {
                void api.disconnect(connection.id).catch(() => {});
                setTarget(connection.target);
                patch(project.id, null);
              }}
            >
              <Unplug size={13} />
            </Button>
          </div>
        </>
      ) : (
        <div className="remote-side-hosts">{hostsBlock}</div>
      )}
    </div>
  );

  const menuEntry =
    menu &&
    Object.values(entries)
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .find((item) => item.path === menu.path);

  const session =
    backend && place?.active ? getFileSession(backend, project.id, place.active) : null;

  return (
    <div className="remote-workspace">
      {slot ? (viewActive ? createPortal(side, slot) : null) : side}
      {!place || !connection ? (
        <div className="remote-connect">
          <div className="remote-connect-card">
            <span className="remote-connect-icon">
              <Server size={22} />
            </span>
            <h2>{t('连接云主机')}</h2>
            <p>{t('通过 SSH 打开主机上的文件夹，在这里浏览、编辑文件和使用终端。')}</p>
            <form className="remote-connect-form" onSubmit={(event) => void connect(event)}>
              <Input
                aria-label={t('主机')}
                placeholder={t('用户名@主机，或 SSH 配置里的主机名')}
                value={target}
                disabled={!!connecting}
                onChange={(event) => {
                  setTarget(event.target.value);
                  setAsking(null);
                }}
              />
              <Button type="submit" variant="primary" disabled={!!connecting || !target.trim()}>
                <Plug size={14} />
                {t('连接')}
              </Button>
            </form>
            {asking ? (
              <form
                className="remote-connect-form"
                onSubmit={(event) => void connect(event, asking, password)}
              >
                <Input
                  type="password"
                  autoFocus
                  aria-label={t('密码')}
                  placeholder={t('{target} 的密码', { target: asking })}
                  value={password}
                  disabled={!!connecting}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <Button type="submit" disabled={!!connecting || !password}>
                  <KeyRound size={14} />
                  {t('登录')}
                </Button>
              </form>
            ) : null}
            {connecting ? (
              <p className="remote-muted remote-connecting" role="status">
                <span className="remote-dot" data-state="connecting" aria-hidden />
                {t('正在连接 {target}…', { target: connecting })}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="error-text">
                {error}
              </p>
            ) : null}
            {/* With the sidebar showing the hosts, the center keeps only the form. */}
            {slot ? null : <div className="remote-connect-hosts">{hostsBlock}</div>}
          </div>
        </div>
      ) : (
        <div className="sf-experiment-code remote-code" ref={area}>
          <div className="sf-experiment-editor remote-editor-area">
            <Collapse open={!!place.lost}>
              <div className="remote-lost" role="status">
                <span
                  className="remote-dot"
                  data-state={reconnecting ? 'connecting' : 'lost'}
                  aria-hidden
                />
                <span className="remote-lost-text">
                  {t('连接已断开')} · {connection.target}
                </span>
                {reconnectPassword !== null ? (
                  <form
                    className="remote-lost-password"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void reconnect(reconnectPassword);
                    }}
                  >
                    <Input
                      type="password"
                      autoFocus
                      aria-label={t('密码')}
                      placeholder={t('{target} 的密码', { target: connection.target })}
                      value={reconnectPassword}
                      disabled={reconnecting}
                      onChange={(event) => setReconnectPassword(event.target.value)}
                    />
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={reconnecting || !reconnectPassword}
                    >
                      <KeyRound size={13} />
                      {t('登录')}
                    </Button>
                  </form>
                ) : (
                  <Button
                    variant="primary"
                    disabled={reconnecting}
                    onClick={() => void reconnect()}
                  >
                    <StateLabel
                      state={reconnecting ? 'busy' : 'idle'}
                      labels={{
                        idle: (
                          <>
                            <RefreshCw size={13} />
                            {t('重新连接')}
                          </>
                        ),
                        busy: (
                          <>
                            <Spinner />
                            {t('重新连接')}
                          </>
                        ),
                      }}
                    />
                  </Button>
                )}
              </div>
            </Collapse>
            {error ? (
              <div className="inline-error" role="alert">
                <span>{error}</span>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label={t('关闭提示')}
                  onClick={() => setError('')}
                >
                  <X size={13} />
                </Button>
              </div>
            ) : null}
            {place.tabs.length ? (
              <>
                <DocumentTabs
                  label={t('云主机文件')}
                  panelId="remote-editor-panel"
                  tabs={place.tabs.map((path) => {
                    const dirty = backend
                      ? getFileSession(backend, project.id, path).getSnapshot().dirty
                      : false;
                    return {
                      id: path,
                      title: `${nameOf(path)}${dirty ? ' ●' : ''}`,
                      icon: <FileText size={13} />,
                    };
                  })}
                  activeId={place.active}
                  onSelect={(id) => patch(project.id, { active: id })}
                  onClose={(id) => void closeTab(id)}
                  onReorder={(tabs) => patch(project.id, { tabs })}
                />
                <div id="remote-editor-panel" role="tabpanel" className="remote-editor-panel">
                  {session ? (
                    <RemoteEditor
                      key={session.path}
                      session={session}
                      readOnly={readOnly}
                      onSelection={(text) =>
                        onContext({
                          projectId: project.id,
                          workspace: 'remote',
                          title: nameOf(session.path),
                          resourceId: session.path,
                          path: session.path,
                          selection: text || undefined,
                        })
                      }
                    />
                  ) : null}
                </div>
              </>
            ) : (
              <div className="sf-ide-welcome remote-welcome">
                <h2>{nameOf(place.folder)}</h2>
                <p className="remote-muted">
                  {connection.target}:{place.folder}
                </p>
                <div className="sf-ide-welcome-actions">
                  <Button variant="ghost" onClick={() => setPicking(true)}>
                    <FolderOpen size={15} />
                    {t('打开文件夹…')}
                  </Button>
                  {!readOnly ? (
                    <Button variant="ghost" onClick={() => void make(false, place.folder)}>
                      <FilePlus2 size={15} />
                      {t('新建文件…')}
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={() => void newTerminal()}>
                    <SquareTerminal size={15} />
                    {t('新建终端')}
                  </Button>
                </div>
              </div>
            )}
          </div>
          <div
            className={`sf-experiment-bottom${panelOpen ? '' : ' is-collapsed'}`}
            style={panelOpen ? { height: panelHeight } : undefined}
          >
            <PanelSash
              label={t('调整面板高度')}
              height={panelHeight}
              open={panelOpen}
              max={() => area.current?.clientHeight ?? 600}
              onResize={setPanelHeight}
              onOpen={setPanelOpen}
              onEnd={(height) => localStorage.setItem(PANEL_KEY, String(height))}
            />
            <header>
              <div role="tablist" aria-label={t('面板')} className="sf-ide-panel-tabs">
                <Button
                  variant="ghost"
                  role="tab"
                  aria-selected={panelOpen}
                  onClick={() => (terminals.length ? setPanelOpen(true) : void newTerminal())}
                >
                  {t('终端')}
                </Button>
              </div>
              <span className="spacer" />
              <Button
                variant="ghost"
                iconOnly
                aria-label={t(panelOpen ? '收起面板' : '展开面板')}
                tooltip={t(panelOpen ? '收起面板' : '展开面板')}
                onClick={() =>
                  terminals.length ? setPanelOpen((open) => !open) : void newTerminal()
                }
              >
                {panelOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </Button>
            </header>
            <div className="sf-terminal-container" hidden={!panelOpen}>
              {panelOpen && terminals.length ? (
                <Suspense fallback={<p>{t('正在读取…')}</p>}>
                  <TerminalPanel
                    projectId={project.id}
                    experimentId={`remote:${connection.id}`}
                    terminals={terminals}
                    activeId={terminalId}
                    onActive={setTerminalId}
                    onError={setError}
                    onCreate={() => newTerminal()}
                  />
                </Suspense>
              ) : null}
            </div>
          </div>
        </div>
      )}
      <Menu anchor={menu?.anchor ?? null} label={t('文件操作')} onClose={() => setMenu(null)}>
        {menu ? (
          <>
            {menuEntry?.kind === 'directory' && !readOnly ? (
              <>
                <Button
                  role="menuitem"
                  variant="ghost"
                  onClick={() => {
                    setMenu(null);
                    void make(false, menu.path);
                  }}
                >
                  {t('新建文件…')}
                </Button>
                <Button
                  role="menuitem"
                  variant="ghost"
                  onClick={() => {
                    setMenu(null);
                    void make(true, menu.path);
                  }}
                >
                  {t('新建文件夹…')}
                </Button>
                <div className="sf-menu-separator" role="separator" />
              </>
            ) : null}
            {menuEntry?.kind === 'directory' ? (
              <>
                <Button
                  role="menuitem"
                  variant="ghost"
                  onClick={() => {
                    setMenu(null);
                    openFolder(menu.path);
                  }}
                >
                  {t('作为文件夹打开')}
                </Button>
                <Button
                  role="menuitem"
                  variant="ghost"
                  onClick={() => {
                    setMenu(null);
                    void newTerminal(menu.path);
                  }}
                >
                  {t('在终端中打开')}
                </Button>
              </>
            ) : null}
            <Button
              role="menuitem"
              variant="ghost"
              onClick={() => {
                setMenu(null);
                void navigator.clipboard?.writeText(menu.path);
              }}
            >
              {t('复制路径')}
            </Button>
            {!readOnly ? (
              <>
                <div className="sf-menu-separator" role="separator" />
                <Button
                  role="menuitem"
                  variant="ghost"
                  onClick={() => {
                    setMenu(null);
                    renameItem(menu.path);
                  }}
                >
                  {t('重命名…')}
                </Button>
                <Button
                  role="menuitem"
                  variant="ghost"
                  className="sf-menu-danger"
                  onClick={() => {
                    setMenu(null);
                    void deleteItem(menu.path);
                  }}
                >
                  {t('删除')}
                </Button>
              </>
            ) : null}
          </>
        ) : null}
      </Menu>
      {picking && place && connection ? (
        <FolderPicker
          api={api}
          connection={connection}
          start={place.folder}
          onPick={(folder) => {
            void api
              .resolve(connection.id, expandHome(folder, connection.home))
              .then(openFolder)
              .catch(fail);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}
