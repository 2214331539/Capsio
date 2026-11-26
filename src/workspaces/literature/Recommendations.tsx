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

const KIND: Record<Recommendation['kind'], string> = { paper: '论文', news: '新闻', blog: '博客' };

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

/** Keys typed into a field are text, not list moves. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * New papers, news and blog posts for a project, picked in the background from what its
 * library is about, each with the reason it was picked. A reading desk: the list on the left,
 * the one being read on the right, J and K to move between them. The page only shows them and
 * passes on what the user does.
 */
export function Recommendations({
  projectId,
  focus,
  onOpenPaper,
  onAsk,
  engine = radar,
}: {
  projectId: string;
  /** A recommendation to show first, such as the one a notice was about. */
  focus?: string | null;
  onOpenPaper: (paperId: string) => void;
  onAsk: (paper: Recommendation) => void;
  engine?: Radar;
}) {
  const [view, setView] = useState<RecommendationsView | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [hinted, setHinted] = useState(() => localStorage.getItem(HINTED) === '1');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  const [reasons, setReasons] = useState<{ paper: Recommendation; anchor: MenuAnchor } | null>(
    null,
  );
  const live = useRef(true);
  const index = useRef<HTMLElement>(null);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  useEffect(() => {
    if (focus) setSelected(focus);
  }, [focus]);

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

  const remaining = view?.items.filter((item) => item.state !== 'dismissed') ?? [];
  // The filter appears once a brief holds both papers and updates.
  const mixed =
    remaining.some((item) => item.kind === 'paper') &&
    remaining.some((item) => item.kind !== 'paper');
  // The day's big news in the user's fields comes first, then the project's own, then what
  // was kept for later; each shows once.
  const seen = new Set<string>();
  const once = (item: Recommendation) => !seen.has(item.id) && !!seen.add(item.id);
  const highlights = (view?.highlights ?? []).filter(
    (item) => item.state !== 'dismissed' && filter !== 'paper' && once(item),
  );
  const shown = remaining.filter((item) => (!mixed || shows(filter, item)) && once(item));
  const waiting = (view?.later ?? []).filter(
    (item) => (!mixed || shows(filter, item)) && once(item),
  );
  const entries = [...highlights, ...shown, ...waiting];
  const current = entries.find((item) => item.id === selected) ?? entries[0] ?? null;

  function select(item: Recommendation | undefined) {
    if (!item) return;
    setSelected(item.id);
    const list = index.current;
    const target = [...(list?.querySelectorAll<HTMLElement>('[data-id]') ?? [])].find(
      (row) => row.dataset.id === item.id,
    );
    // Focus in the list follows the selection, so its ring never marks another row.
    if (list?.contains(document.activeElement)) target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  }
  function step(by: number) {
    const at = current ? entries.indexOf(current) : -1;
    select(entries[Math.min(Math.max(at + by, 0), entries.length - 1)]);
  }

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
    // Reading goes on with the next one.
    const at = entries.indexOf(paper);
    const next = entries[at + 1] ?? entries[at - 1];
    if (next) setSelected(next.id);
    mark(paper.id, 'dismissed');
    engine.feedback(projectId, paper.id, 'dismissed', { reason }).catch(failed);
    toastUndo(t('已忽略'), async () => {
      await engine.feedback(projectId, paper.id, 'dismissed', { undo: true });
      await load();
    });
  }

  function row(item: Recommendation) {
    const state =
      item.state === 'saved' ? t('已加入') : item.state === 'later' ? t('稍后读') : null;
    return (
      <li key={item.id}>
        <button
          type="button"
          className="recommendations-row"
          data-id={item.id}
          aria-current={item === current ? 'true' : undefined}
          onClick={() => select(item)}
        >
          <span className="recommendations-row-meta">
            <span className="recommendations-row-kind">{t(KIND[item.kind])}</span>
            <span className="recommendations-row-source">
              {[item.venue, item.published].filter(Boolean).join(' · ')}
            </span>
            {state ? <span className="recommendations-row-state">{state}</span> : null}
          </span>
          <span className="recommendations-row-title">{item.title}</span>
          {item.reason ? <span className="recommendations-row-reason">{item.reason}</span> : null}
        </button>
      </li>
    );
  }

  function group(label: string, items: Recommendation[]) {
    return items.length ? (
      <section className="recommendations-group" aria-label={t(label)}>
        <h3>{t(label)}</h3>
        <ol>{items.map(row)}</ol>
      </section>
    ) : null;
  }

  function detail(paper: Recommendation) {
    return (
      <article key={paper.id} className="recommendation" aria-label={paper.title}>
        <p className="recommendation-byline">
          <span className="recommendation-kind">{t(KIND[paper.kind])}</span>
          {byline(paper)}
        </p>
        <h2 className="recommendation-title">{paper.title}</h2>
        {paper.originalTitle !== paper.title ? (
          <p className="recommendation-original">{paper.originalTitle}</p>
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
          <Button size="sm" onClick={() => open(paper)}>
            {t('打开原文')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAsk(paper)}>
            {t('问 AI')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={paper.state === 'later'}
            onClick={() => later(paper)}
          >
            {paper.state === 'later' ? t('已稍后读') : t('稍后读')}
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
        {paper.reason ? (
          <section className="recommendation-section">
            <h3>{t('推荐理由')}</h3>
            <p>{paper.reason}</p>
          </section>
        ) : null}
        {paper.summary ? (
          <section className="recommendation-section">
            <h3>{t('摘要')}</h3>
            <p>{paper.summary}</p>
          </section>
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
        {entries.length > 1 ? (
          <p className="recommendation-keys">
            <kbd>J</kbd> <kbd>K</kbd> {t('切换下一条、上一条')}
          </p>
        ) : null}
      </article>
    );
  }

  const status =
    view && view.state !== 'ready'
      ? t(EMPTY[view.state])
      : view?.state === 'ready' && !shown.length
        ? t('今天的推荐都处理完了。')
        : null;
  return (
    <section
      className="recommendations"
      aria-label={t('推荐')}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
        const key = event.key.toLowerCase();
        if (key === 'j' || key === 'arrowdown') step(1);
        else if (key === 'k' || key === 'arrowup') step(-1);
        else return;
        event.preventDefault();
      }}
    >
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
      {error ? (
        <p className="recommendations-error" role="alert">
          {error}
        </p>
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
      {entries.length ? (
        <div className="recommendations-desk">
          <nav className="recommendations-index" aria-label={t('推荐列表')} ref={index}>
            {group('领域要闻', highlights)}
            {status ? <p className="recommendations-status">{status}</p> : null}
            {group('项目推荐', shown)}
            {group('稍后读', waiting)}
          </nav>
          <div className="recommendations-reader">{current ? detail(current) : null}</div>
        </div>
      ) : view ? (
        <p className="recommendations-empty">{status}</p>
      ) : null}
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
