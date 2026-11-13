import { useEffect, useRef, useState } from 'react';
import { HiOutlineCheck, HiOutlineClipboardDocument } from 'react-icons/hi2';
import './CopyButton.css';

type CopyState = 'idle' | 'copied' | 'failed';

const RESET_AFTER_MS = 2000;

/**
 * Copies `value` in full to the clipboard. The outcome ("Copied" or "Copy failed") shows next
 * to the button and is announced to screen readers. `label` names what is copied, for example
 * "address", and becomes the button's name: "Copy address".
 */
export default function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const mounted = useRef(true);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(resetTimer.current);
    };
  }, []);

  const copy = async () => {
    let outcome: CopyState;
    try {
      // Without a secure context `navigator.clipboard` is missing; that lands in the catch too.
      await navigator.clipboard.writeText(value);
      outcome = 'copied';
    } catch {
      outcome = 'failed';
    }
    if (!mounted.current) return;
    window.clearTimeout(resetTimer.current);
    setState(outcome);
    resetTimer.current = window.setTimeout(() => setState('idle'), RESET_AFTER_MS);
  };

  const name = `Copy ${label}`;
  return (
    <span className="copy-button-wrap">
      <button type="button" className="copy-button" onClick={copy} aria-label={name} title={name}>
        {state === 'copied' ? <HiOutlineCheck aria-hidden="true" /> : <HiOutlineClipboardDocument aria-hidden="true" />}
      </button>
      <span className={`copy-button-status ${state}`} role="status" aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}
