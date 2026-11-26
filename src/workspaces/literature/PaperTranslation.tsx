import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Clock, Download, FolderOpen, PauseCircle } from 'lucide-react';
import { confirmAction } from '../../components/prompts';
import { Button } from '../../components/primitives';
import { toast } from '../../components/feedback';
import type { WorkContext } from '../../domain/context';
import { t } from '../../i18n';
import type { LibraryPaper } from '../../platform/library';
import { translator, type TranslationStatus, type Translator } from '../../platform/translator';
import { isMacOS } from '../../platform/os';
import type { RecordStore } from '../../reader/PdfReader';
import { translationAsset, type PdfSpot } from '../../reader/pdf-sync';

const PdfReader = lazy(() => import('../../reader/PdfReader'));
/** A translation finished on another device arrives by sync; look again now and then. */
const POLL = 5000;

/**
 * A paper's full-text translation beside it: a PDF with the original's layout,
 * formulas and figures. Translation happens in the background by itself; opening the
 * pane shows it, or how far it has got and why it may be waiting. It keeps the paper's
 * pages, so it shares the paper's highlights and any place in it is the same place in
 * the paper.
 */
export function PaperTranslation({
  projectId,
  paper,
  title,
  record,
  readOnly = false,
  onLocate,
  onContext,
  engine = translator,
}: {
  projectId: string;
  paper?: LibraryPaper;
  title: string;
  /** The paper's own record: highlights made here are the paper's. */
  record?: RecordStore;
  readOnly?: boolean;
  /** Shows a place of the translation in the paper. */
  onLocate?: (spot: PdfSpot) => void;
  onContext?: (context: WorkContext) => void;
  engine?: Translator;
}) {
  const paperId = paper?.id ?? '';
  const fingerprint = paper?.fingerprint ?? '';
  const [status, setStatus] = useState<TranslationStatus | null>(null);
  const [problem, setProblem] = useState('');
  const done = status?.state === 'done';
  useEffect(() => {
    if (!paperId) return;
    let live = true;
    const show = (value: TranslationStatus) => live && setStatus(value);
    void engine
      .open(projectId, paperId)
      .then(show)
      .catch(() => show({ state: 'waiting', progress: 0 }));
    const stop = engine.events((event) => {
      if (event.projectId === projectId && event.fingerprint === fingerprint) show(event.status);
    });
    return () => {
      live = false;
      void stop.then((unlisten) => unlisten());
    };
  }, [engine, projectId, paperId, fingerprint]);
  // Progress comes as events; this catches what they cannot: a translation synced from
  // another device, a place in the queue, a pause running out.
  useEffect(() => {
    if (!paperId || done) return;
    const timer = window.setInterval(() => {
      void engine
        .status(projectId, paperId)
        .then(setStatus)
        .catch(() => {});
    }, POLL);
    return () => window.clearInterval(timer);
  }, [engine, projectId, paperId, done]);
  const backend = useMemo(
    () => ({ readPdf: () => engine.pdf(projectId, paperId) }),
    [engine, projectId, paperId],
  );
  async function run(action: () => Promise<void>) {
    setProblem('');
    try {
      await action();
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    }
  }
  // For a translation that came out incomplete: translated paragraphs come from this
  // device's cache, so mostly the missing ones are paid for again.
  async function retranslate() {
    if (!(await confirmAction(t('重新翻译这篇论文？会再消耗一些点数。')))) return;
    await run(async () => setStatus(await engine.retranslate(projectId, paperId)));
  }
  const name = t('{title}（译文）', { title });
  const counterpart = useMemo(
    () => (onLocate ? { label: t('原文位置'), locate: onLocate } : undefined),
    [onLocate],
  );

  return (
    <section className="paper-translation" aria-label={t('全文翻译')}>
      {done && paper ? (
        <div className="paper-translation-reader">
          <div className="paper-translation-bar">
            {problem ? (
              <span role="alert">{problem}</span>
            ) : onLocate ? (
              <span className="paper-translation-tip">
                {isMacOS() ? t('⌘ + 点击定位原文') : t('Ctrl + 点击定位原文')}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void run(async () => {
                  if (await engine.save(projectId, paperId, name)) toast(t('已导出译文'));
                })
              }
            >
              <Download size={14} aria-hidden="true" />
              {t('导出 PDF')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={t('在文件管理器中显示')}
              tooltip={t('在文件管理器中显示')}
              onClick={() => void run(() => engine.reveal(projectId, paperId))}
            >
              <FolderOpen size={14} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void retranslate()}>
              {t('重新翻译')}
            </Button>
          </div>
          <Suspense fallback={<p className="muted">{t('正在打开阅读器…')}</p>}>
            <PdfReader
              assetId={translationAsset(paper.id, fingerprint)}
              paperId={paper.id}
              title={name}
              projectId={projectId}
              backend={backend}
              compact
              record={record}
              readOnly={readOnly}
              counterpart={counterpart}
              onContext={(context) => onContext?.(context)}
              onTool={() => {}}
            />
          </Suspense>
        </div>
      ) : (
        <div className="paper-translation-empty" data-state={status?.state ?? 'waiting'}>
          <TranslationWait
            status={status}
            onResume={() =>
              void run(async () => setStatus(await engine.resume(projectId, paperId)))
            }
            onRetry={() => void retranslate()}
          />
          {problem ? <p role="alert">{problem}</p> : null}
        </div>
      )}
    </section>
  );
}

/** What the pane says before the translation is there. */
function TranslationWait({
  status,
  onResume,
  onRetry,
}: {
  status: TranslationStatus | null;
  onResume(): void;
  onRetry(): void;
}) {
  if (status?.state === 'paused') {
    const minutes = Math.max(1, Math.ceil((status.resumeIn ?? 0) / 60));
    return (
      <>
        <PauseCircle size={22} aria-hidden="true" />
        <p role="status">
          <strong>
            {t('翻译暂停：{reason}', { reason: status.reason ?? t('模型暂时不可用') })}
          </strong>
        </p>
        <p>{t('{minutes} 分钟后自动重试', { minutes })}</p>
        <Button size="sm" onClick={onResume}>
          {t('立即重试')}
        </Button>
      </>
    );
  }
  if (status?.state === 'failed')
    return (
      <>
        <AlertCircle size={22} aria-hidden="true" />
        <p role="status">
          <strong>{t('这篇论文没能翻译出来')}</strong>
        </p>
        {status.reason ? <p>{status.reason}</p> : null}
        <Button size="sm" onClick={onRetry}>
          {t('重新翻译')}
        </Button>
      </>
    );
  const translating = status?.state === 'translating';
  const progress = translating ? Math.max(0, Math.min(100, status.progress)) : 0;
  const ahead = status?.state === 'waiting' ? (status.ahead ?? 0) : 0;
  const known = translating && progress > 0;
  return (
    <>
      {ahead > 0 ? <Clock size={22} aria-hidden="true" /> : null}
      <div
        className="paper-translation-progress"
        role="progressbar"
        aria-label={t('翻译进度')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(progress) : undefined}
        data-indeterminate={!known || undefined}
      >
        <span style={{ width: `${known ? progress : 30}%` }} />
      </div>
      <p role="status">
        {translating
          ? known
            ? t('正在翻译 {progress}%', { progress: Math.round(progress) })
            : t('正在翻译…')
          : ahead > 0
            ? t('排队中，前面还有 {count} 篇', { count: ahead })
            : t('准备翻译…')}
      </p>
      <p className="paper-translation-hint">{t('翻译在后台进行，可以先去做别的。')}</p>
    </>
  );
}
