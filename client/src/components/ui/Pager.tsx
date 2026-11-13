import { useRef } from 'react';
import { formatNumber } from '../../utils/formatters';
import './tableControls.css';

interface PagerProps {
  page: number;
  pages: number;
  onPage: (page: number) => void;
  /** Names the navigation landmark, for example "Masternode pages". */
  label: string;
}

/** First / previous / next / last buttons with "Page X of Y". Renders nothing for a single page. */
export default function Pager({ page, pages, onPage, label }: PagerProps) {
  const labelRef = useRef<HTMLSpanElement>(null);
  if (pages <= 1) return null;
  const go = (target: number) => {
    const next = Math.min(pages, Math.max(1, target));
    onPage(next);
    // On the first or last page the pressed button turns disabled and would drop keyboard focus.
    if (next === 1 || next === pages) labelRef.current?.focus({ preventScroll: true });
  };
  return (
    <nav className="pagination" aria-label={label}>
      <button type="button" onClick={() => go(1)} disabled={page <= 1} aria-label="First page">
        &laquo;
      </button>
      <button type="button" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page">
        &lsaquo;
      </button>
      <span className="pager-label" aria-live="polite" tabIndex={-1} ref={labelRef}>
        Page {formatNumber(page)} of {formatNumber(pages)}
      </span>
      <button type="button" onClick={() => go(page + 1)} disabled={page >= pages} aria-label="Next page">
        &rsaquo;
      </button>
      <button type="button" onClick={() => go(pages)} disabled={page >= pages} aria-label="Last page">
        &raquo;
      </button>
    </nav>
  );
}
