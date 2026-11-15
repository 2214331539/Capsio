import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/** A collapsible group in a side view, like VS Code's "Changes" or "Outline". */
export function SideSection({
  title,
  count,
  actions,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="sf-side-section" data-open={open}>
      <header>
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <ChevronRight size={13} aria-hidden="true" />
          <span>{title}</span>
        </button>
        {actions ? <span className="sf-side-section-actions">{actions}</span> : null}
        {count ? <span className="sf-side-section-count">{count}</span> : null}
      </header>
      {open ? <div className="sf-side-section-body">{children}</div> : null}
    </section>
  );
}
