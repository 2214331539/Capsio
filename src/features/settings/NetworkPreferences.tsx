import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Dropdown, Input } from '../../components/primitives';
import { t } from '../../i18n';
import type { NetworkSettings } from '../../domain/workspace';
import type { WorkspaceStore } from '../../stores/workspace';

const MODES: [NetworkSettings['proxy'], string][] = [
  ['system', '跟随系统'],
  ['none', '不使用代理'],
  ['manual', '手动设置'],
];

/** An http://host:port without credentials or a path, as the app takes it (network.rs). */
export function proxyAddress(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** The proxy every connection goes through: AI, translation, search, sync and the browser. */
export function NetworkPreferences({ store }: { store: WorkspaceStore }) {
  const saved = useStore(store, (s) => s.data?.settings.network);
  const busy = useStore(store, (s) => s.busy);
  const ready = useStore(store, (s) => !!s.data);
  const mode = saved?.proxy ?? 'system';
  const [address, setAddress] = useState(saved?.proxyUrl ?? '');
  const [error, setError] = useState('');
  useEffect(() => setAddress(saved?.proxyUrl ?? ''), [saved?.proxyUrl]);
  function save(next: NetworkSettings) {
    void store.getState().update((d) => {
      d.settings.network = next;
    });
  }
  function commitAddress() {
    if (!address.trim()) return setError('');
    const checked = proxyAddress(address);
    if (!checked) return setError(t('代理地址要写成 http://地址:端口。'));
    setError('');
    setAddress(checked);
    if (checked !== saved?.proxyUrl) save({ proxy: 'manual', proxyUrl: checked });
  }
  return (
    <>
      <div className="settings-group">
        <div className="settings-item">
          <div className="preference-fields">
            <label>
              {t('代理')}
              <Dropdown
                aria-label={t('代理')}
                disabled={busy || !ready}
                value={mode}
                onChange={(event) => {
                  const proxy = event.target.value as NetworkSettings['proxy'];
                  setError('');
                  save(
                    proxy === 'manual'
                      ? { proxy, proxyUrl: proxyAddress(address) ?? '' }
                      : { proxy },
                  );
                }}
              >
                {MODES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
              </Dropdown>
            </label>
          </div>
        </div>
        {mode === 'manual' ? (
          <div className="settings-item">
            <label className="settings-input-row">
              {t('代理地址')}
              <Input
                value={address}
                placeholder="http://127.0.0.1:7890"
                spellCheck={false}
                disabled={busy}
                aria-invalid={!!error || undefined}
                onChange={(event) => setAddress(event.target.value)}
                onBlur={commitAddress}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitAddress();
                }}
              />
            </label>
          </div>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="error-text settings-error">
          {error}
        </p>
      ) : null}
      <p className="settings-note">
        {t(
          'AI、翻译、文献检索、同步和内置浏览器都按这里连接，本机地址不走代理。改动对新的连接生效，内置浏览器要重新打开标签页。',
        )}
      </p>
    </>
  );
}
