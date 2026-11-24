// Capsio was called Scientify. Where the old app is still installed, Capsio offers to remove it:
// once in a toast, and in Settings → About for as long as it is there.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { toast, toastError } from '../../components/feedback';
import { t, translateError } from '../../i18n';

export type RenamedApp = { path: string; dataInside: boolean };

const NOTICED = 'capsio.renamed.noticed';

export function renamedApp(): Promise<RenamedApp | null> {
  if (!isTauri()) return Promise.resolve(null);
  return invoke<RenamedApp | null>('renamed_app').catch(() => null);
}

export function openDataSettings() {
  window.dispatchEvent(new CustomEvent('capsio-open-settings', { detail: 'data' }));
}

/** Windows opens Scientify's own uninstaller, where the user confirms; macOS moves it to the Trash. */
export async function uninstallRenamedApp() {
  try {
    const done = await invoke<'opened' | 'trashed'>('uninstall_renamed_app');
    toast(
      done === 'trashed'
        ? t('旧版 Scientify 已移到废纸篓。')
        : t('已打开 Scientify 的卸载程序，按提示完成即可。'),
      { tone: 'success' },
    );
  } catch (reason) {
    toastError(translateError(String(reason)));
  }
}

/** The first start that finds Scientify still installed says so, with a way to remove it. */
export async function noticeRenamedApp() {
  try {
    if (localStorage.getItem(NOTICED)) return;
  } catch {
    return;
  }
  const old = await renamedApp();
  if (!old) return;
  try {
    localStorage.setItem(NOTICED, '1');
  } catch {
    /* Shown again next time, which is harmless. */
  }
  if (old.dataInside)
    toast(
      t('Scientify 已更名为 Capsio。旧版目录里还有正在用的数据，要卸载旧版，先把数据搬到别处。'),
      { duration: 20000, action: { label: t('数据与备份'), run: openDataSettings } },
    );
  else
    toast(t('Scientify 已更名为 Capsio，项目和设置都已接上。'), {
      duration: 20000,
      action: { label: t('卸载旧版'), run: uninstallRenamedApp },
    });
}
