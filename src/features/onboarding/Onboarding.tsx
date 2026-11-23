import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Button } from '../../components/primitives';
import { t, translateError } from '../../i18n';
import type { WorkspaceStore } from '../../stores/workspace';
import { restartApp, useDataLocation } from '../settings/DataLocation';
import { Tour, type TourStep } from './Tour';

// The project tour shows again once when its pages change (v2: five modules, 2026-11).
const KEYS = { center: 'capsio.tour.center.v1', project: 'capsio.tour.project.v2' };
type Which = keyof typeof KEYS;

function seen(which: Which) {
  try {
    return localStorage.getItem(KEYS[which]) === 'done';
  } catch {
    return true;
  }
}
function remember(which: Which) {
  try {
    localStorage.setItem(KEYS[which], 'done');
  } catch {
    /* A tour that cannot be remembered may show again. */
  }
}

/** On a fresh installation: where the data will live, before anything is in it. */
function DataChoice({ store }: { store: WorkspaceStore }) {
  const data = useDataLocation(store);
  if (!data.ready) return null;
  return (
    <div className="sf-tour-data">
      <span>{t('数据保存在')}</span>
      <code>{data.next ?? data.directory}</code>
      {data.next ? (
        <div>
          <Button variant="primary" onClick={() => void restartApp()}>
            {t('重启后使用')}
          </Button>
          <Button variant="ghost" onClick={() => void data.change('cancel')}>
            {t('取消')}
          </Button>
        </div>
      ) : (
        <div>
          <Button disabled={data.blocked} onClick={() => void data.change('move')}>
            {t('换个位置')}
          </Button>
          <Button disabled={data.blocked} onClick={() => void data.change('adopt')}>
            {t('使用已有数据')}
          </Button>
        </div>
      )}
      {data.error ? <span role="alert">{translateError(data.error)}</span> : null}
    </div>
  );
}

export function centerSteps(store: WorkspaceStore, fresh: boolean): TourStep[] {
  return [
    {
      title: t('欢迎使用 Capsio'),
      body: t('读文献、写代码、写论文，都在一个窗口里。花一分钟认识一下。'),
      content: fresh ? <DataChoice store={store} /> : undefined,
    },
    {
      target: '[data-tour="new-project"]',
      title: t('一个课题，一个项目'),
      body: t('文献、代码、稿件和 AI 对话都放在项目里。'),
    },
    {
      target: '.sf-searchbox',
      title: t('搜索与命令'),
      body: t('Ctrl K 找项目、论文和笔记，也能直接执行命令。'),
    },
    {
      target: '[data-tour="account"]',
      title: t('设置与帮助'),
      body: t(
        'AI 模型、数据位置、账号和帮助都在这里，也能再看一遍导览。打开一个项目，继续认识里面的功能。',
      ),
    },
  ];
}

export function projectSteps(): TourStep[] {
  return [
    {
      target: '.sf-nav',
      title: t('五个模块'),
      body: t('文献读论文，文档记想法，实验写代码、跑实验，写作编译 LaTeX，云主机连服务器。'),
    },
    {
      target: '[data-tour="import-library"]',
      title: t('从 Zotero 搬过来'),
      body: t('导入 Zotero 文库或 BibTeX、RIS，分类、PDF、笔记和高亮都会带上。'),
    },
    {
      target: '[data-tour="browser"]',
      title: t('内置浏览器'),
      body: t('查资料、下论文，不用离开 Capsio。'),
    },
    {
      target: '[data-tour="share"]',
      title: t('共享'),
      body: t('邀请同学或同事，一起读、一起写。'),
    },
    {
      target: '[data-tour="notes"]',
      title: t('边看边记'),
      body: t('在右侧打开项目文档，读论文、跑实验时随手记下。'),
    },
    {
      target: '[data-tour="assistant"]',
      title: t('AI 助手'),
      body: t('每个页面都能用：读论文、改代码、跑实验、写文档。不知道问什么，就点它给的起步问题。'),
    },
  ];
}

/**
 * Shows the window's main controls once: the project center at first launch,
 * the inside of a project the first time one is open. Help → 功能导览 replays.
 */
export function Onboarding({
  store,
  ready,
  inProject,
  auto = import.meta.env.MODE !== 'test',
}: {
  store: WorkspaceStore;
  ready: boolean;
  inProject: boolean;
  /** Start by itself the first time; tests of other screens turn it off. */
  auto?: boolean;
}) {
  const which: Which = inProject ? 'project' : 'center';
  const [running, setRunning] = useState<Which | null>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (!auto || !ready || running || seen(which)) return;
    // Let the page settle, and never start over a dialog.
    const timer = setTimeout(() => {
      if (document.querySelector('dialog[open]')) return;
      const data = store.getState().data;
      setFresh(isTauri() && !import.meta.env.DEV && !data?.projects.length);
      setRunning(which);
    }, 700);
    return () => clearTimeout(timer);
  }, [auto, ready, which, running, store]);
  useEffect(() => {
    const replay = () => {
      setFresh(false);
      setRunning(which);
    };
    window.addEventListener('capsio-start-tour', replay);
    return () => window.removeEventListener('capsio-start-tour', replay);
  }, [which]);
  if (!running) return null;
  return (
    <Tour
      key={running}
      label={t('功能导览')}
      steps={running === 'center' ? centerSteps(store, fresh) : projectSteps()}
      onFinish={() => {
        remember(running);
        setRunning(null);
      }}
    />
  );
}
