import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import './Footer.css';

const SERVER_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
  timeZone: 'UTC',
  timeZoneName: 'short',
});

const BUILD_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
  timeZoneName: 'short',
});

function formatUtcDate(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? BUILD_DATE_FORMATTER.format(new Date(parsed)) : null;
}

export default function Footer() {
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [tickMs, setTickMs] = useState(() => Date.now());
  const buildMeta = __BUILD_META__;

  useEffect(() => {
    const interval = window.setInterval(() => setTickMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let alive = true;

    const syncServerOffset = async () => {
      try {
        const { data } = await api.get<{ timestamp?: string }>('/health');
        const parsed = typeof data?.timestamp === 'string' ? Date.parse(data.timestamp) : NaN;
        if (alive && Number.isFinite(parsed)) {
          setServerOffsetMs(parsed - Date.now());
        }
      } catch {
        // Keep local offset when server health endpoint is temporarily unavailable.
      }
    };

    syncServerOffset();
    const refresh = window.setInterval(syncServerOffset, 60_000);
    return () => {
      alive = false;
      window.clearInterval(refresh);
    };
  }, []);

  const serverTimeLabel = useMemo(() => {
    const serverNow = new Date(tickMs + serverOffsetMs);
    return `Server Time: ${SERVER_TIME_FORMATTER.format(serverNow)}`;
  }, [serverOffsetMs, tickMs]);

  const buildDateLabel = useMemo(() => formatUtcDate(buildMeta.date) ?? 'unknown', [buildMeta.date]);
  const commitDateLabel = useMemo(() => formatUtcDate(buildMeta.commitDate), [buildMeta.commitDate]);

  const buildTitle = `Build ID: ${buildMeta.id}\nBuild date: ${buildMeta.date}\nCommit: ${buildMeta.commitTitle}\nHash: ${buildMeta.shortHash}\nCommit date: ${buildMeta.commitDate}`;

  return (
    <footer className="footer">
      <div className="footer-inner container">
        <div className="footer-top">
          <div className="footer-brand">
            <strong>DeFCoN Explorer</strong>
            <span>Realtime chain intelligence for the DeFCoN network.</span>
          </div>

          <nav className="footer-links" aria-label="Footer links">
            <Link to="/">Dashboard</Link>
            <Link to="/mining">Rewards</Link>
            <Link to="/network">Network</Link>
            <Link to="/chain-health">Nodes</Link>
            <Link to="/masternodes">Masternodes</Link>
            <Link to="/ban-detection">PoSe Watch</Link>
            <Link to="/api">API</Link>
            <Link to="/about">About</Link>
          </nav>
        </div>

        <div className="footer-bottom">
          <p>{serverTimeLabel}</p>
          <p>{new Date().getFullYear()} DeFCoN Explorer</p>
          <div className="footer-build-info" title={buildTitle}>
            <p className="footer-build-id">Build {buildMeta.id}</p>
            <p className="footer-build-date">Built {buildDateLabel}</p>
            <p className="footer-build-hash">Commit {buildMeta.shortHash} · {buildMeta.commitTitle}</p>
            <p className="footer-build-commit-date">
              Committed {commitDateLabel ? <time dateTime={buildMeta.commitDate}>{commitDateLabel}</time> : 'unknown'}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
