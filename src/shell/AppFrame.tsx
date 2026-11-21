import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import '../components/layout/layout.css';
import './frame.css';
import { slideIn } from '../platform/motion';
import { platformClass } from '../platform/os';
import { OfflineBanner, useOnline } from './OfflineBanner';

/** One window: title bar on top; sidebar, main surface and the right panel below. */
export function AppFrame({
  titlebar,
  sidebar,
  sidebarOpen,
  children,
  dialogs,
  rightWidth,
}: {
  titlebar: ReactNode;
  sidebar: ReactNode;
  sidebarOpen: boolean;
  children: ReactNode;
  dialogs: ReactNode;
  rightWidth: number;
}) {
  const body = useRef<HTMLDivElement>(null);
  const online = useOnline();
  const wasOpen = useRef(sidebarOpen);
  // Only a toggle slides the sidebar in; switching pages swaps it in place.
  useLayoutEffect(() => {
    if (sidebarOpen && !wasOpen.current)
      slideIn([body.current?.querySelector(':scope > .sf-sidebar')], '-8px 0');
    wasOpen.current = sidebarOpen;
  }, [sidebarOpen]);
  return (
    <div
      className={`app-shell research-shell sf-frame ${platformClass()}`}
      style={{ '--dock-width': `${rightWidth}px` } as CSSProperties}
      data-offline={online ? undefined : 'true'}
    >
      {titlebar}
      <OfflineBanner online={online} />
      <div ref={body} className="sf-frame-body" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
        {sidebarOpen ? sidebar : null}
        <div className="sf-frame-main">{children}</div>
      </div>
      {dialogs}
    </div>
  );
}
