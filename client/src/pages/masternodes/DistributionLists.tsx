import { formatNumber } from '../../utils/formatters';
import './DistributionLists.css';

export interface CountryRank {
  /** Country code, or the page's key for the combined "Others" row. */
  key: string;
  name: string;
  count: number;
}

export interface ProviderRank {
  provider: string;
  count: number;
  tagged: number;
  auto: number;
}

const percent = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

/**
 * Countries as a ranked list of bars: the largest first, each with its node count and its share of
 * all active nodes. Pressing a row filters the table to that country; pressing it again clears it.
 */
export function CountryRanking({
  rows,
  total,
  activeKey,
  onToggle,
}: {
  rows: CountryRank[];
  total: number;
  activeKey: string | null;
  onToggle: (row: CountryRank) => void;
}) {
  return (
    <ol className="mn-rank-list" role="list" aria-label="Masternodes by country">
      {rows.map((row) => {
        const share = percent(row.count, total);
        const active = activeKey === row.key;
        return (
          <li key={row.key}>
            <button
              type="button"
              className={`mn-rank-row${active ? ' active' : ''}`}
              aria-pressed={active}
              onClick={() => onToggle(row)}
            >
              <span className="mn-rank-head">
                <span className="mn-rank-name">{row.name}</span>
                <span className="mn-rank-value">
                  <strong>{formatNumber(row.count)}</strong>
                  <span className="text-muted">{share.toFixed(1)}%</span>
                </span>
              </span>
              <span className="mn-rank-track" aria-hidden="true">
                <span className="mn-rank-fill" style={{ width: `${share}%` }} />
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Hosting providers as a ranked list: every provider named, its bar split into nodes whose provider
 * was detected automatically and nodes inside a tagged address range, with a legend for the two.
 */
export function ProviderRanking({
  providers,
  activeProvider,
  onToggle,
}: {
  providers: ProviderRank[];
  activeProvider: string | null;
  onToggle: (row: ProviderRank) => void;
}) {
  const largest = Math.max(0, ...providers.map((row) => row.count));
  return (
    <>
      <ul className="mn-rank-legend" role="list" aria-label="Legend">
        <li>
          <span className="mn-rank-swatch auto" aria-hidden="true" /> Auto detected
        </li>
        <li>
          <span className="mn-rank-swatch tagged" aria-hidden="true" /> Tagged address ranges
        </li>
      </ul>
      <ol className="mn-rank-list" role="list" aria-label="Masternodes by hosting provider">
        {providers.map((row) => {
          const active = activeProvider === row.provider;
          const width = percent(row.count, largest);
          const taggedShare = percent(row.tagged, row.count);
          return (
            <li key={row.provider}>
              <button
                type="button"
                className={`mn-rank-row${active ? ' active' : ''}`}
                aria-pressed={active}
                onClick={() => onToggle(row)}
                title={`${row.provider}: ${formatNumber(row.auto)} auto detected, ${formatNumber(row.tagged)} in tagged ranges`}
              >
                <span className="mn-rank-head">
                  <span className="mn-rank-name">{row.provider}</span>
                  <span className="mn-rank-value">
                    <strong>{formatNumber(row.count)}</strong>
                    <span className="text-muted">{formatNumber(row.tagged)} tagged</span>
                  </span>
                </span>
                <span className="mn-rank-track" aria-hidden="true">
                  <span className="mn-rank-stack" style={{ width: `${width}%` }}>
                    <span className="mn-rank-fill auto" style={{ width: `${100 - taggedShare}%` }} />
                    <span className="mn-rank-fill tagged" style={{ width: `${taggedShare}%` }} />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}
