/**
 * Zooming a view with Ctrl + mouse wheel or a trackpad pinch. Chromium (WebView2) sends a
 * pinch as a wheel event with Ctrl held; WebKit (macOS) sends gesture events instead, so
 * both are listened to. `zoom` gets the factor to apply and the point under the pointer,
 * relative to `host`. Returns a function that stops listening.
 */
export function listenZoom(
  host: HTMLElement,
  zoom: (factor: number, at: { x: number; y: number }) => void,
) {
  const at = (event: { clientX: number; clientY: number }) => {
    const rect = host.getBoundingClientRect();
    return { x: Math.max(0, event.clientX - rect.left), y: Math.max(0, event.clientY - rect.top) };
  };
  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    if (!event.deltaY) return;
    const delta =
      event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1);
    zoom(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.002), at(event));
  };
  // WebKit's GestureEvent: `scale` is relative to where the pinch began.
  type Gesture = Event & { scale?: number; clientX: number; clientY: number };
  let last = 1;
  const start = (event: Event) => {
    event.preventDefault();
    last = 1;
  };
  const change = (event: Event) => {
    event.preventDefault();
    const scale = (event as Gesture).scale;
    if (!scale) return;
    zoom(scale / last, at(event as Gesture));
    last = scale;
  };
  host.addEventListener('wheel', wheel, { passive: false });
  host.addEventListener('gesturestart', start);
  host.addEventListener('gesturechange', change);
  return () => {
    host.removeEventListener('wheel', wheel);
    host.removeEventListener('gesturestart', start);
    host.removeEventListener('gesturechange', change);
  };
}
