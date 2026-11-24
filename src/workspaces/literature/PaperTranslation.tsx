import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { confirmAction } from '../../components/prompts';
import { Button } from '../../components/primitives';
import type { WorkContext } from '../../domain/context';
import { t } from '../../i18n';
import type { LibraryPaper } from '../../platform/library';
import { translator, type TranslationStatus, type Translator } from '../../platform/translator';
import { ProgressRing } from '../../features/translation/ProgressRing';

const PdfReader = lazy(() => import('../../reader/PdfReader'));
/** A translation finished on another device arrives by sync; look again now and then. */
const POLL = 5000;

/**
 * A paper's full-text translation beside it: a PDF with the original's layout,
 * formulas and figures. Translation happens in the background by itself; opening the
 * pane only shows it, or how far it has got.
 */
export function PaperTranslation({
  projectId,
  paper,
  title,
  onContext,
  engine = translator,
}: {
  projectId: string;
  paper?: LibraryPaper;
  title: string;
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
  useEffect(() => {
    if (!paperId || done) return;
    const timer = window.setInterval(() => {
      void engine
        .status(projectId, paperId)
        .then((value) => value.state === 'done' && setStatus(value))
        .catch(() => {});
    }, POLL);
    return () => window.clearInterval(timer);
  }, [engine, projectId, paperId, done]);
  const backend = useMemo(
    () => ({ readPdf: () => engine.pdf(projectId, paperId) }),
    [engine, projectId, paperId],
  );
  // For a translation that came out incomplete: translated paragraphs come from this
  // device's cache, so mostly the missing ones are paid for again.
  async function retranslate() {
    if (!(await confirmAction(t('重新翻译这篇论文？会再消耗一些点数。')))) return;
    setProblem('');
    try {
      setStatus(await engine.retranslate(projectId, paperId));
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <section className="paper-translation" aria-label={t('全文翻译')}>
      {done && paper ? (
        <div className="paper-translation-reader">
          <div className="paper-translation-bar">
            {problem ? <span role="alert">{problem}</span> : null}
            <Button variant="ghost" size="sm" onClick={() => void retranslate()}>
              {t('重新翻译')}
            </Button>
          </div>
          <Suspense fallback={<p className="muted">{t('正在打开阅读器…')}</p>}>
            <PdfReader
              assetId={`translation:${paper.id}:${fingerprint}`}
              paperId={paper.id}
              title={t('{title}（译文）', { title })}
              projectId={projectId}
              backend={backend}
              compact
              onContext={(context) => onContext?.(context)}
              onTool={() => {}}
            />
          </Suspense>
        </div>
      ) : (
        <div className="paper-translation-empty">
          <ProgressRing
            size={30}
            value={status?.state === 'translating' ? status.progress : undefined}
            label={t('翻译进度')}
          />
          <p role="status">
            {status?.state === 'translating' && status.progress > 0
              ? t('正在翻译 {progress}%', { progress: Math.round(status.progress) })
              : t('正在翻译…')}
          </p>
        </div>
      )}
    </section>
  );
}
