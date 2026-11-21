import { FolderInput, Languages, Trash2, X } from 'lucide-react';
import { Button } from '../../components/primitives';
import { t } from '../../i18n';

/** What can be done with several selected files at once. It stays mounted and fades in when
 *  more than one row is selected, so the page beneath never shifts. */
export function BatchBar({
  open,
  count,
  translatable,
  busy,
  readOnly,
  moving,
  onMove,
  onTranslate,
  onTrash,
  onClear,
}: {
  open: boolean;
  count: number;
  /** How many of the selection are PDFs that can be translated. */
  translatable: number;
  busy: boolean;
  readOnly: boolean;
  /** The folder menu is open from this bar. */
  moving: boolean;
  onMove(trigger: HTMLButtonElement): void;
  onTranslate(): void;
  onTrash(): void;
  onClear(): void;
}) {
  return (
    <div
      className="library-batch"
      data-open={open}
      inert={!open}
      role="toolbar"
      aria-label={t('批量操作')}
    >
      <span className="library-batch-count" role="status">
        {t('已选 {count} 项', { count })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={moving}
        disabled={busy || readOnly}
        onClick={(event) => onMove(event.currentTarget)}
      >
        <FolderInput />
        {t('移动到')}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy || !translatable} onClick={onTranslate}>
        <Languages />
        {t('全文翻译')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="library-batch-danger"
        disabled={busy || readOnly}
        onClick={onTrash}
      >
        <Trash2 />
        {t('移入回收站')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={t('取消选择')}
        tooltip={t('取消选择')}
        onClick={onClear}
      >
        <X />
      </Button>
    </div>
  );
}
