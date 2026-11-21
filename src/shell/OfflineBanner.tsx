import { useEffect, useRef, useSyncExternalStore } from 'react';
import { WifiOff } from 'lucide-react';
import { toast } from '../components/feedback';
import { t } from '../i18n';

function subscribe(listener: () => void) {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

export function useOnline() {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

/** One line under the title bar while the network is down; a short toast when it is back. */
export function OfflineBanner({ online }: { online: boolean }) {
  const was = useRef(online);
  useEffect(() => {
    if (online && !was.current) toast(t('网络已恢复'), { tone: 'success' });
    was.current = online;
  }, [online]);
  if (online) return null;
  return (
    <div className="sf-offline" role="status">
      <WifiOff aria-hidden="true" />
      {t('网络已断开，恢复后会自动同步。')}
    </div>
  );
}
