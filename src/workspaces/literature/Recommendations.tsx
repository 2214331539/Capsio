import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button, segmentThumb } from '../../components/primitives';
import { Menu, type MenuAnchor } from '../../components/primitives/Menu';
import { toast, toastUndo } from '../../components/feedback';
import { errorMessage } from '../../domain/errors';
import { t } from '../../i18n';
import { openBrowserSource } from '../../platform/browser-pane';
import {
  radar,
  type Radar,
  type Recommendation,
  type Recommendations as RecommendationsView,
} from '../../platform/radar';
import { dismissBrief } from '../../features/recommendations/briefs';
import './recommendations.css';

/** While the first brief is being prepared, the page looks again this often. */
const POLL = 60_000;
const HINTED = 'capsio.recommendations.hinted';
const REASONS = [
  ['unrelated', '不相关'],
  ['weak', '质量一般'],
  ['seen', '看过了'],
] as const;

const EMPTY: Record<Exclude<RecommendationsView['state'], 'ready'>, string> = {
  off: '个性化推荐已关闭，可以在 设置 → 数据与备份 里打开。',
  needsPapers: '文献库里有 3 篇以上论文后，这里会每天推荐相关的新论文和动态。',
  noModel: '在 AI 模型 里选好模型后，这里会每天推荐相关的新论文和动态。',
  preparing: '正在为这个项目准备推荐，第一次需要几分钟。',
};

/** Papers apart from news and blog posts, which the page calls updates. */
type Filter = 'all' | 'paper' | 'post';
const FILTERS: [Filter, string][] = [
  ['all', '全部'],
  ['paper', '论文'],
  ['post', '动态'],
];
const shows = (filter: Filter, item: Recommendation) =>
  filter === 'all' || (filter === 'paper') === (item.kind === 'paper');

function dayLabel(day: string) {
  const local = (offset: number) => {
    const date = new Date(Date.now() - offset * 86_400_000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  if (day === local(0)) return t('今天');
  if (day === local(1)) return t('昨天');
  return day;
}

function byline(item: Recommendation) {
  if (item.kind !== 'paper') return [item.venue, item.published].filter(Boolean).join(' · ');
  const names = item.authors.slice(0, 3).join(', ');
  const authors = item.authors.length > 3 ? t('{names} 等', { names }) : names;
  return [authors, item.venue, item.published].filter(Boolean).join(' · ');
}

/**
 * New papers, news and blog posts for a project, picked in the background from what its
 * library is about, each with the reason it was picked. The page only shows them and passes
 * on what the user does.
 */
export function Recommendations({
  projectId,
  onOpenPaper,
  onAsk,
  engine = radar,
}: {
  projectId: string;
  onOpenPaper: (paperId: string) => void;
  onAsk: (paper: Recommendation) => void;
  engine?: Radar;
}) {
  const [view, setView] = useState<RecommendationsView | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [hinted, setHinted] = useState(() => localStorage.getItem(HINTED) === '1');
  const [filter, setFilter] = useState<Filter>('all');
  const [reasons, setReasons] = useState<{ paper: Recommendation; anchor: MenuAnchor } | null>(
    null,
  );
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const load = useCallback(
    () =>
      engine
        .view(projectId)
        .then((next) => {
          if (!live.current) return;
          setView(next);
          setError('');
        })
        .catch((reason) => live.current && setError(errorMessage(reason))),
    [engine, projectId],
  );
  useEffect(() => {
    void load();
    dismissBrief(projectId);
  }, [load, projectId]);
  // A brief made while the page is open shows at once.
  useEffect(() => {
    const stop = engine.briefs((brief) => {
      if (brief.projectId !== projectId) return;
      dismissBrief(projectId);
      void load();
    });
    return () => void stop.then((unlisten) => unlisten());
  }, [engine, projectId, load]);
  useEffect(() => {
    if (view?.state !== 'preparing') return;
    const timer = window.setInterval(() => void load(), POLL);
    return () => window.clearInterval(timer);
  }, [view?.state, load]);

  const mark = (id: string, state: Recommendation['state']) =>
    setView((current) => {
      if (!current) return current;
      const update = (item: Recommendation) => (item.id === id ? { ...item, state } : item);
      // The later list keeps only what is still for later.
      return {
        ...current,
        items: current.items.map(update),
        highlights: current.highlights.map(update),
        later: current.later.map(update).filter((item) => item.state === 'later'),
      };
    });
  const failed = (reason: unknown) => setError(errorMessage(reason));

  function open(paper: Recommendation) {
    void engine.feedback(projectId, paper.id, 'opened').catch(() => {});
    void openBrowserSource(projectId, paper.url).catch(failed);
  }
  async function save(paper: Recommendation) {
    setSaving(paper.id);
    try {
      const outcome = await engine.save(projectId, paper.id);
      if (outcome.kind === 'added') {
        mark(paper.id, 'saved');
        toast(t('已加入文献库'), {
          tone: 'success',
          action: { label: t('打开'), run: () => onOpenPaper(outcome.paperId) },
        });
      } else {
        toast(t('这篇论文没有公开的 PDF，已打开原文页面。'));
        await openBrowserSource(projectId, outcome.url);
      }
    } catch (reason) {
      failed(reason);
    } finally {
      if (live.current) setSaving(null);
    }
  }
  function later(paper: Recommendation) {
    const undo = paper.state === 'later';
    mark(paper.id, undo ? null : 'later');
    engine.feedback(projectId, paper.id, 'later', { undo }).catch(failed);
  }
  function dismiss(paper: Recommendation, reason: string) {
    mark(paper.id, 'dismissed');
    engine.feedback(projectId, paper.id, 'dismissed', { reason }).catch(failed);
    toastUndo(t('已忽略'), async () => {
      await engine.feedback(projectId, paper.id, 'dismissed', { undo: true });
      await load();
    });
  }

  function card(paper: Recommendation) {
    return (
      <li key={paper.id} className="recommendation">
        <button type="button" className="recommendation-title" onClick={() => open(paper)}>
          {paper.title}
        </button>
        {paper.originalTitle !== paper.title ? (
          <p className="recommendation-original">{paper.originalTitle}</p>
        ) : null}
        <p className="recommendation-byline">
          {paper.kind !== 'paper' ? (
            <span className="recommendation-kind">
              {paper.kind === 'news' ? t('新闻') : t('博客')}
            </span>
          ) : null}
          {byline(paper)}
        </p>
        {paper.summary ? <p className="recommendation-summary">{paper.summary}</p> : null}
        {paper.reason ? (
          <p className="recommendation-reason">
            <span className="recommendation-label">{t('推荐理由')}</span>
            {paper.reason}
          </p>
        ) : null}
        {paper.also.length ? (
          <p className="recommendation-also">
            {t('另有 {count} 个来源：', { count: paper.also.length })}
            {paper.also.map((report) => (
              <button
                key={report.url}
                type="button"
                onClick={() => void openBrowserSource(projectId, report.url).catch(failed)}
              >
                {report.source}
              </button>
            ))}
          </p>
        ) : null}
        <div className="recommendation-actions">
          {paper.kind === 'paper' ? (
            <Button
              size="sm"
              variant={paper.state === 'saved' ? 'ghost' : 'primary'}
              disabled={paper.state === 'saved' || saving === paper.id}
              onClick={() => void save(paper)}
            >
              {paper.state === 'saved'
                ? t('已加入文献库')
                : saving === paper.id
                  ? t('正在下载…')
                  : t('加入文献库')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={paper.state === 'later'}
            onClick={() => later(paper)}
          >
            {paper.state === 'later' ? t('已稍后读') : t('稍后读')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAsk(paper)}>
            {t('问 AI')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-haspopup="menu"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setReasons({
                paper,
                anchor: { x: box.left, y: box.bottom, trigger: event.currentTarget },
              });
            }}
          >
            {t('不感兴趣')}
          </Button>
        </div>
      </li>
    );
  }

  const remaining = view?.items.filter((item) => item.state !== 'dismissed') ?? [];
  // The filter appears once a brief holds both papers and updates.
  const mixed =
    remaining.some((item) => item.kind === 'paper') &&
    remaining.some((item) => item.kind !== 'paper');
  const shown = remaining.filter((item) => !mixed || shows(filter, item));
  const waiting = (view?.later ?? []).filter((item) => !mixed || shows(filter, item));
  // The day's big news in the user's fields, above every project's own recommendations.
  const highlights = (view?.highlights ?? []).filter(
    (item) => item.state !== 'dismissed' && filter !== 'paper',
  );
  return (
    <section className="recommendations" aria-label={t('推荐')}>
      <header className="workspace-commandbar">
        <span className="workspace-name">{t('推荐')}</span>
        {view?.day ? <span className="recommendations-day">{dayLabel(view.day)}</span> : null}
        {mixed ? (
          <div
            ref={segmentThumb}
            className="sf-segmented recommendations-filter"
            role="group"
            aria-label={t('显示的内容')}
          >
            {FILTERS.map(([value, label]) => (
              <Button
                key={value}
                variant="ghost"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {t(label)}
              </Button>
            ))}
          </div>
        ) : null}
      </header>
      <div className="recommendations-body">
        {error ? (
          <p className="recommendations-error" role="alert">
            {error}
          </p>
        ) : null}
        {highlights.length ? (
          <section className="recommendations-highlights" aria-label={t('领域要闻')}>
            <h3>{t('领域要闻')}</h3>
            <ol className="recommendations-list">{highlights.map(card)}</ol>
          </section>
        ) : null}
        {view && view.state !== 'ready' ? (
          <p className="recommendations-empty">{t(EMPTY[view.state])}</p>
        ) : null}
        {view?.state === 'ready' && !hinted ? (
          <p className="recommendations-hint">
            {t('推荐根据项目里的论文自动生成，可以在设置里关闭。')}
            <Button
              variant="ghost"
              iconOnly
              aria-label={t('知道了')}
              onClick={() => {
                localStorage.setItem(HINTED, '1');
                setHinted(true);
              }}
            >
              <X />
            </Button>
          </p>
        ) : null}
        {view?.state === 'ready' ? (
          shown.length ? (
            <ol className="recommendations-list">{shown.map(card)}</ol>
          ) : (
            <p className="recommendations-empty">{t('今天的推荐都处理完了。')}</p>
          )
        ) : null}
        {waiting.length ? (
          <section className="recommendations-later" aria-label={t('稍后读')}>
            <h3>{t('稍后读')}</h3>
            <ol className="recommendations-list">{waiting.map(card)}</ol>
          </section>
        ) : null}
      </div>
      <Menu
        anchor={reasons?.anchor ?? null}
        label={t('不感兴趣的原因')}
        onClose={() => setReasons(null)}
      >
        {REASONS.map(([reason, label]) => (
          <Button
            key={reason}
            role="menuitem"
            onClick={() => {
              if (reasons) dismiss(reasons.paper, reason);
              setReasons(null);
            }}
          >
            {t(label)}
          </Button>
        ))}
      </Menu>
    </section>
  );
}
