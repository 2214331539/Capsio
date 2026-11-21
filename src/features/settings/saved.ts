import { useCallback, useEffect, useRef, useState } from 'react';

/** True for a moment after `flash()`, so a button can say "saved" in place and then go back. */
export function useSavedFlash(ms = 1800) {
  const [on, setOn] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    setOn(false);
  }, []);
  const flash = useCallback(() => {
    window.clearTimeout(timer.current);
    setOn(true);
    timer.current = window.setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, flash, clear] as const;
}
