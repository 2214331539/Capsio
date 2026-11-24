import { useEffect, useState } from 'react';
import { Button } from '../../components/primitives';
import { t } from '../../i18n';
import { renamedApp, uninstallRenamedApp, type RenamedApp } from './renamed-app';

/** In Settings → About while Scientify, Capsio's old name, is still installed. */
export function RenamedAppRow({ onData }: { onData(): void }) {
  const [old, setOld] = useState<RenamedApp | null>(null);
  useEffect(() => {
    void renamedApp().then(setOld);
  }, []);
  if (!old) return null;
  return (
    <div className="settings-renamed" role="status">
      <span>
        {old.dataInside
          ? t('旧版 Scientify 还装着，它的目录里有 Capsio 正在用的数据。')
          : t('旧版 Scientify 还装着，可以卸载了。')}
      </span>
      {old.dataInside ? (
        <Button size="sm" onClick={onData}>
          {t('数据与备份')}
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() => void uninstallRenamedApp().then(() => renamedApp().then(setOld))}
        >
          {t('卸载旧版')}
        </Button>
      )}
    </div>
  );
}
