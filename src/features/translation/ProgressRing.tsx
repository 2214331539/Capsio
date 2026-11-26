import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Languages, PauseCircle } from 'lucide-react';
import { t } from '../../i18n';
import {
  translator as nativeTranslator,
  type TranslationStatus,
  type Translator,
} from '../../platform/translator';
import './translator.css';

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A small ring that fills with `value` (0–100); without one it turns, for work whose end is
 *  not known yet. Only the turning is animated, the fill follows each report as it comes. */
export function ProgressRing({
  value,
  size = 14,
  label,
}: {
  value?: number;
  size?: number;
  label?: string;
}) {
  const known = value !== undefined && value > 0;
  const percent = Math.max(0, Math.min(100, value ?? 0));
  return (
    <svg
      className="sf-progress-ring"
      data-indeterminate={!known || undefined}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(percent) : undefined}
    >
      <circle className="sf-progress-ring-track" cx="8" cy="8" r={RADIUS} />
      <circle
        className="sf-progress-ring-arc"
        cx="8"
        cy="8"
        r={RADIUS}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - (known ? percent : 28) / 100)}
      />
    </svg>
  );
}

/** What a translation tab shows before its name: the language mark, the ring while it works,
 *  or a still mark when it is paused or failed, so nothing turns for work that is not moving. */
export function TranslationIcon({ status }: { status?: TranslationStatus }) {
  if (status?.state === 'paused') return <PauseCircle size={14} aria-label={t('翻译已暂停')} />;
  if (status?.state === 'failed')
    return <AlertCircle size={14} aria-label={t('这篇论文没能翻译出来')} />;
  if (status && status.state !== 'done')
    return (
      <ProgressRing
        value={status.state === 'translating' ? status.progress : undefined}
        label={t('翻译进度')}
      />
    );
  return <Languages size={14} />;
}

/** The translation status of some papers, kept live: asked once, then pushed by progress
 *  events. Papers are named by id and PDF fingerprint. */
export function useTranslationStatus(
  projectId: string,
  papers: { id: string; fingerprint: string }[],
  engine: Translator = nativeTranslator,
) {
  const [status, setStatus] = useState<Record<string, TranslationStatus>>({});
  const key = papers.map((paper) => `${paper.id}:${paper.fingerprint}`).join('|');
  const wanted = useMemo(() => papers, [key]);
  useEffect(() => {
    let live = true;
    const show = (fingerprint: string, value: TranslationStatus) =>
      live && setStatus((current) => ({ ...current, [fingerprint]: value }));
    for (const paper of wanted)
      void engine
        .status(projectId, paper.id)
        .then((value) => show(paper.fingerprint, value))
        .catch(() => {});
    const stop = engine.events((event) => {
      if (event.projectId === projectId) show(event.fingerprint, event.status);
    });
    return () => {
      live = false;
      void stop.then((unlisten) => unlisten());
    };
  }, [engine, projectId, wanted]);
  return status;
}
