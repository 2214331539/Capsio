import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ChevronRight, FileText, Folder } from 'lucide-react';
import { Button } from '../primitives';
import { easing, motion, reducedMotion } from '../../platform/motion';
import './tree-view.css';

export interface TreeItem {
  id: string;
  label: string;
  children?: TreeItem[];
  icon?: ReactNode;
  tooltip?: string;
  draggable?: boolean;
  /** A short status at the end of the row, such as a Git change letter. */
  decoration?: { text: string; tone: 'modified' | 'added' | 'deleted' | 'conflict' | 'ignored' };
}

/** A row being named in place, like a new folder in VS Code's explorer. */
interface TreeDraft {
  /** Renames this existing row in place; without it a new row is added under `parent`. */
  id?: string;
  /** A folder unless given; only the icon differs. */
  kind?: 'file' | 'folder';
  parent: string;
  value: string;
  error?: string;
  label: string;
  onChange(value: string): void;
  onCommit(): void;
  onCancel(): void;
}

interface Props {
  items: TreeItem[];
  draft?: TreeDraft | null;
  label: string;
  selectedId?: string | null;
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (ids: Set<string>, activeId: string) => void;
  dropTargetId?: string | null;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onContextMenu?: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
}

/** Plain activation opens; modifier selection and keyboard navigation keep the editor stable. */
export function TreeView({
  items,
  draft,
  label,
  selectedId,
  selectedIds,
  onSelectionChange,
  dropTargetId,
  collapsed,
  onToggle,
  onOpen,
  onContextMenu,
}: Props) {
  const [focused, setFocused] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const anchor = useRef<string | null>(null);
  const visible: {
    item: TreeItem;
    parent?: string;
    depth: number;
    position: number;
    size: number;
  }[] = [];
  let draftAt = -1;
  let draftDepth = 0;
  function collect(nodes: TreeItem[], parent?: string, depth = 0) {
    // The draft row sits after the last folder of its parent, before the files.
    const here = draft && !draft.id && (parent ?? '') === draft.parent;
    const lastFolder = nodes.reduce((last, node, index) => (node.children ? index : last), -1);
    const mark = () => {
      draftAt = visible.length;
      draftDepth = depth;
    };
    if (here && lastFolder < 0) mark();
    nodes.forEach((item, position) => {
      visible.push({ item, parent, depth, position, size: nodes.length });
      if (item.children && !collapsed.has(item.id)) collect(item.children, item.id, depth + 1);
      if (here && position === lastFolder) mark();
    });
  }
  collect(items);
  // Rows revealed by expanding a folder fade in; everything else appears at once.
  const seen = useRef<Set<string> | null>(null);
  const lastCollapsed = useRef(collapsed);
  useLayoutEffect(() => {
    const ids = new Set(visible.map((row) => row.item.id));
    // Only `has` is used: callers may pass any set-like object.
    const opened = visible.some(
      ({ item }) => item.children && lastCollapsed.current.has(item.id) && !collapsed.has(item.id),
    );
    if (seen.current && opened && !reducedMotion())
      for (const id of ids)
        if (!seen.current.has(id))
          elements.current.get(id)?.animate?.(
            [
              { opacity: 0, translate: '0 -4px' },
              { opacity: 1, translate: '0 0' },
            ],
            { duration: motion.content, easing: easing.enter },
          );
    seen.current = ids;
    lastCollapsed.current = collapsed;
  });
  const committed = useRef(false);
  // A rejected name leaves the field open; blurring it afterwards cancels, as in VS Code.
  useEffect(() => {
    committed.current = false;
  }, [draft?.error]);
  const renderDraft = (depth: number, icon?: ReactNode) =>
    draft ? (
      <div
        key="__draft__"
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={false}
        className="sf-tree-row sf-tree-draft"
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <span className="sf-tree-disclosure" aria-hidden="true" />
        <span className="sf-tree-icon" aria-hidden="true">
          {icon ?? (draft.kind === 'file' ? <FileText /> : <Folder />)}
        </span>
        <span className="sf-tree-draft-field">
          <input
            className="sf-tree-input"
            aria-label={draft.label}
            aria-invalid={draft.error ? true : undefined}
            value={draft.value}
            autoFocus
            spellCheck={false}
            ref={(input) => {
              // Renaming selects the name without its extension, as file explorers do.
              if (!input || !draft.id || input.dataset.selected) return;
              input.dataset.selected = 'true';
              const dot = draft.kind === 'file' ? input.value.lastIndexOf('.') : -1;
              input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
            }}
            onFocus={() => (committed.current = false)}
            onChange={(event) => draft.onChange(event.target.value)}
            onKeyDown={(event) => {
              // Keys belong to the text field, not the tree's copy, paste and menu shortcuts.
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                committed.current = true;
                draft.onCommit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                committed.current = true;
                draft.onCancel();
              }
            }}
            onBlur={() => {
              if (committed.current) return;
              committed.current = true;
              if (draft.value.trim() && !draft.error) draft.onCommit();
              else draft.onCancel();
            }}
          />
          {draft.error ? (
            <span className="sf-tree-input-error" role="alert">
              {draft.error}
            </span>
          ) : null}
        </span>
      </div>
    ) : null;
  const draftRow = renderDraft(draftDepth);
  const tabStop =
    [focused, selectedId].find((id) => visible.some((row) => row.item.id === id)) ??
    visible[0]?.item.id;
  const focus = (id?: string) => {
    if (!id) return;
    setFocused(id);
    elements.current.get(id)?.focus();
  };
  function select(id: string, range: boolean, toggle: boolean) {
    if (!onSelectionChange) return;
    let next = new Set<string>();
    if (range) {
      const start = visible.findIndex((row) => row.item.id === (anchor.current ?? selectedId));
      const end = visible.findIndex((row) => row.item.id === id);
      if (toggle) next = new Set(selectedIds);
      for (const row of visible.slice(
        Math.min(start < 0 ? end : start, end),
        Math.max(start, end) + 1,
      ))
        next.add(row.item.id);
    } else {
      anchor.current = id;
      next = toggle ? new Set(selectedIds) : new Set();
      if (toggle && next.has(id)) next.delete(id);
      else next.add(id);
    }
    onSelectionChange(next, id);
  }
  return (
    <div
      role="tree"
      aria-label={label}
      aria-multiselectable={onSelectionChange ? true : undefined}
      className="sf-tree"
    >
      {draftAt === 0 ? draftRow : null}
      {visible.map(({ item, depth, position, size }, index) => {
        const folder = item.children !== undefined;
        const expanded = folder && !collapsed.has(item.id);
        if (draft?.id === item.id)
          return renderDraft(depth, item.icon ?? (folder ? <Folder /> : <FileText />));
        return [
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            role="treeitem"
            data-tree-id={item.id}
            data-drop-target={item.id === dropTargetId ? 'true' : undefined}
            draggable={item.draggable}
            className="sf-tree-row"
            ref={(element) => {
              if (element) elements.current.set(item.id, element);
              else elements.current.delete(item.id);
            }}
            aria-label={item.label}
            tooltip={item.tooltip ?? item.id}
            aria-level={depth + 1}
            aria-posinset={position + 1}
            aria-setsize={size}
            aria-expanded={folder ? expanded : undefined}
            aria-selected={selectedIds ? selectedIds.has(item.id) : selectedId === item.id}
            tabIndex={item.id === tabStop ? 0 : -1}
            style={{ paddingLeft: 8 + depth * 16 }}
            onFocus={() => setFocused(item.id)}
            onClick={(event) => {
              select(item.id, event.shiftKey, event.ctrlKey || event.metaKey);
              if (onSelectionChange && (event.shiftKey || event.ctrlKey || event.metaKey)) return;
              if (folder) onToggle(item.id);
              else onOpen(item.id);
            }}
            onContextMenu={(event) => {
              if (!onContextMenu) return;
              event.preventDefault();
              event.stopPropagation();
              onContextMenu?.(item.id, event);
            }}
            onKeyDown={(event) => {
              const index = visible.findIndex((row) => row.item.id === item.id);
              if (
                onSelectionChange &&
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === 'a'
              ) {
                event.preventDefault();
                onSelectionChange(new Set(visible.map((row) => row.item.id)), item.id);
                return;
              }
              if (
                onSelectionChange &&
                event.key === ' ' &&
                (event.ctrlKey || event.metaKey || event.shiftKey)
              ) {
                event.preventDefault();
                select(item.id, event.shiftKey, event.ctrlKey || event.metaKey);
                return;
              }
              let destination: string | undefined;
              if (event.key === 'ArrowDown') destination = visible[index + 1]?.item.id;
              else if (event.key === 'ArrowUp') destination = visible[index - 1]?.item.id;
              else if (event.key === 'Home') destination = visible[0]?.item.id;
              else if (event.key === 'End') destination = visible.at(-1)?.item.id;
              else if (event.key === 'ArrowRight') {
                if (folder && !expanded) onToggle(item.id);
                else if (folder) focus(item.children?.[0]?.id);
              } else if (event.key === 'ArrowLeft') {
                if (expanded) onToggle(item.id);
                else focus(visible[index]?.parent);
              } else return;
              if (destination) {
                focus(destination);
                if (event.shiftKey) select(destination, true, event.ctrlKey || event.metaKey);
              }
              event.preventDefault();
            }}
          >
            <span className="sf-tree-disclosure" aria-hidden="true">
              {folder ? <ChevronRight /> : null}
            </span>
            <span className="sf-tree-icon" aria-hidden="true">
              {item.icon ?? (folder ? <Folder /> : <FileText />)}
            </span>
            <span className="sf-tree-label">{item.label}</span>
            {item.decoration ? (
              <span className="sf-tree-decoration" data-tone={item.decoration.tone}>
                {item.decoration.text}
              </span>
            ) : null}
          </Button>,
          index + 1 === draftAt ? draftRow : null,
        ];
      })}
    </div>
  );
}
