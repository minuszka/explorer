export type RouteSeo = {
  title: string;
  description: string;
  keywords: string;
  robots: string;
};

export type ResolvedRouteSeo = RouteSeo & {
  canonicalPath: string;
};

export const DEFAULT_SITE_URL = 'https://deftrack.xyz';
export const SITE_NAME = 'DefTrack - DeFCoN (DFCN) Explorer';
export const DEFAULT_ROBOTS =
  'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1';

export const DEFAULT_ROUTE_SEO: RouteSeo = {
  title: 'DefTrack | DFCN Blockchain Explorer, Masternodes & Live TX',
  description:
    'Track DFCN blocks, live transactions, TX lookup, wallet activity, masternodes, rewards, and network stats in real time.',
  keywords:
    'DeFCoN, DFCN, blockchain explorer, live transactions, tx lookup, masternodes, staking rewards, network stats',
  robots: DEFAULT_ROBOTS,
};

const exactRoutes: Record<string, RouteSeo> = {
  '/blocks': {
    title: 'Latest Blocks | DefTrack DeFCoN Explorer',
    description: 'Browse latest DeFCoN (DFCN) blocks with height, timestamp, reward split, and confirmations.',
    keywords: 'DeFCoN blocks, DFCN block explorer, latest blocks, block confirmations',
    robots: DEFAULT_ROBOTS,
  },
  '/txs': {
    title: 'Latest Transactions | DefTrack DeFCoN Explorer',
    description: 'Live DeFCoN transaction feed with value flow, reward labels, and block references.',
    keywords: 'DeFCoN transactions, DFCN tx explorer, crypto transaction tracker',
    robots: DEFAULT_ROBOTS,
  },
  '/richlist': {
    title: 'Rich List | DefTrack DeFCoN Explorer',
    description: 'Rank DeFCoN addresses by balance and analyze holder distribution.',
    keywords: 'DeFCoN rich list, DFCN top holders, wallet distribution',
    robots: DEFAULT_ROBOTS,
  },
  '/mining': {
    title: 'Rewards Analytics | DefTrack DeFCoN Explorer',
    description: 'Track DeFCoN masternode and staking reward metrics, economics, and network activity.',
    keywords: 'DeFCoN rewards, DFCN masternode reward, staking reward analytics',
    robots: DEFAULT_ROBOTS,
  },
  '/network': {
    title: 'Network Analytics | DefTrack DeFCoN Explorer',
    description: 'Monitor DeFCoN peer network, geo distribution, protocol state, and connectivity health.',
    keywords: 'DeFCoN network, DFCN peers, blockchain network health',
    robots: DEFAULT_ROBOTS,
  },
  '/chain-health': {
    title: 'Node Monitor | DefTrack DeFCoN Explorer',
    description:
      'Compare DeFCoN seed, test, and DNS-discovered nodes by chain height, block hash, version, and connectivity.',
    keywords: 'DeFCoN nodes, DFCN seed nodes, chain health, block hash monitor, node version monitor',
    robots: DEFAULT_ROBOTS,
  },
  '/masternodes': {
    title: 'Masternodes | DefTrack DeFCoN Explorer',
    description: 'Analyze DeFCoN masternode endpoints, country distribution, and operational footprint.',
    keywords: 'DeFCoN masternodes, DFCN node map, masternode analytics',
    robots: DEFAULT_ROBOTS,
  },
  '/provider-tags': {
    title: 'Provider Tags | DefTrack Operator Diagnostics',
    description:
      'Review community-submitted CIDR provider labels and their live DeFCoN masternode coverage.',
    keywords: 'DeFCoN provider tags, DFCN CIDR labels, masternode hosting provider attribution',
    robots: DEFAULT_ROBOTS,
  },
  '/mn-health': {
    title: 'MN Health | DefTrack DeFCoN Explorer',
    description:
      'Real-time DeFCoN masternode health: status snapshot, drop timeline, top offenders, and event history with POSE_BANNED tracking.',
    keywords:
      'DeFCoN masternode health, DFCN POSE banned, masternode uptime, MN drop timeline, masternode monitoring',
    robots: DEFAULT_ROBOTS,
  },
  '/ban-detection': {
    title: 'PoSe Watch | DefTrack DeFCoN Explorer',
    description:
      'Monitor historical DeFCoN PoSe drop waves, recoveries, current penalties, and per-wave masternode details.',
    keywords:
      'DeFCoN ban wave, DFCN POSE banned coordination, masternode mass ban, network attack detection',
    robots: DEFAULT_ROBOTS,
  },
  '/devtools/pose-penalty': {
    title: 'PoSe Penalty Watch | DefTrack DeFCoN Explorer',
    description:
      'Current DeFCoN masternodes receiving PoSe penalty points before they become POSE_BANNED, including IP, service and visible wallet or protocol version.',
    keywords:
      'DeFCoN PoSe penalty, DFCN masternode warning, masternode version monitor, DeFCoN operator diagnostics',
    robots: DEFAULT_ROBOTS,
  },
  '/devtools/node-inventory': {
    title: 'Node Version Inventory | DefTrack DeFCoN Explorer',
    description:
      'Historical DeFCoN node inventory for wallet versions, chain hash alignment, data sources, and upgrade monitoring.',
    keywords:
      'DeFCoN node version, DFCN upgrade monitor, ChainLock inventory, DeFCoN node scanner, masternode version history',
    robots: DEFAULT_ROBOTS,
  },
  '/devtools/network-noise': {
    title: 'Network Noise Monitor | DefTrack Operator Diagnostics',
    description:
      'Correlated DeFCoN node log signals for ChainLock conflicts, chain divergence, PoSe instability, peer churn, and synchronization pressure.',
    keywords: 'DeFCoN network noise, ChainLock monitor, DFCN node logs, PoSe diagnostics, peer instability',
    robots: 'noindex, nofollow',
  },
  '/bubblemaps': {
    title: 'Bubblemaps | DefTrack DeFCoN Explorer',
    description: 'Interactive address relationship graph for DeFCoN with transfer-weighted links and balance-sized nodes.',
    keywords: 'DeFCoN bubblemaps, DFCN address graph, wallet relationship map, on-chain flow graph',
    robots: DEFAULT_ROBOTS,
  },
  '/mempool': {
    title: 'Mempool | DefTrack DeFCoN Explorer',
    description: 'Inspect pending DeFCoN transactions in mempool with fee and size context.',
    keywords: 'DeFCoN mempool, DFCN pending transactions, blockchain mempool',
    robots: DEFAULT_ROBOTS,
  },
  '/api': {
    title: 'API Documentation | DefTrack DeFCoN Explorer',
    description:
      'Developer API for DeFCoN explorer data: blocks, transactions, masternodes, stats, and network telemetry.',
    keywords: 'DeFCoN API, DFCN API, blockchain explorer API, masternode monitoring API',
    robots: DEFAULT_ROBOTS,
  },
  '/about': {
    title: 'About DeFCoN (DFCN) | DefTrack Explorer',
    description: 'Overview of DeFCoN network parameters, links, and core ecosystem references.',
    keywords: 'DeFCoN about, DFCN tokenomics, DeFCoN network information',
    robots: DEFAULT_ROBOTS,
  },
  '/search': {
    title: 'Search Results | DefTrack DeFCoN Explorer',
    description: 'Search DeFCoN blocks, transactions, and wallet addresses.',
    keywords: 'DeFCoN search, DFCN explorer search',
    robots: 'noindex, follow',
  },
  '/test': {
    title: 'Telemetry Test | DefTrack',
    description: 'Internal telemetry test page for upcoming Proof-of-Resources charts.',
    keywords: 'DefTrack test page',
    robots: 'noindex, nofollow',
  },
};

const prefixRoutes: Array<{ prefix: string; seo: RouteSeo }> = [
  {
    prefix: '/block/',
    seo: {
      title: 'Block Details | DefTrack DeFCoN Explorer',
      description: 'Inspect DeFCoN block transactions, producer, reward outputs, and block metadata.',
      keywords: 'DeFCoN block details, DFCN block transactions, blockchain data',
      robots: DEFAULT_ROBOTS,
    },
  },
  {
    prefix: '/tx/',
    seo: {
      title: 'Transaction Details | DefTrack DeFCoN Explorer',
      description: 'View DeFCoN transaction inputs, outputs, confirmations, and net value movement.',
      keywords: 'DeFCoN transaction details, DFCN txid, blockchain transaction',
      robots: DEFAULT_ROBOTS,
    },
  },
  {
    prefix: '/masternode/',
    seo: {
      title: 'Masternode Details | DefTrack DeFCoN Explorer',
      description: 'Inspect one DeFCoN masternode: status, payout and owner addresses, hosting, version and PoSe history.',
      keywords: 'DeFCoN masternode, DFCN masternode details, proTxHash, PoSe history',
      robots: DEFAULT_ROBOTS,
    },
  },
  {
    prefix: '/address/',
    seo: {
      title: 'Address Details | DefTrack DeFCoN Explorer',
      description: 'Explore DFCN wallet balance, received/sent totals, and address transaction history.',
      keywords: 'DeFCoN address, DFCN wallet, blockchain address balance',
      robots: DEFAULT_ROBOTS,
    },
  },
];

const canonicalAliases: Record<string, string> = {
  '/wallets': '/richlist',
  '/crawler': '/chain-health',
  '/devtools/provider-tags': '/provider-tags',
  '/searchv2': '/search',
};

function normalizePathname(pathname: string): string {
  const raw = String(pathname || '/').split(/[?#]/, 1)[0] || '/';
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : '/';
}

export function resolveRouteSeo(pathname: string): ResolvedRouteSeo {
  const normalizedPath = normalizePathname(pathname);
  const canonicalPath = canonicalAliases[normalizedPath] || normalizedPath;

  if (canonicalPath === '/') return { ...DEFAULT_ROUTE_SEO, canonicalPath };

  const exact = exactRoutes[canonicalPath];
  if (exact) return { ...exact, canonicalPath };

  const prefix = prefixRoutes.find((entry) => canonicalPath.startsWith(entry.prefix));
  if (prefix) return { ...prefix.seo, canonicalPath };

  return {
    title: 'Page Not Found | DefTrack DeFCoN Explorer',
    description: DEFAULT_ROUTE_SEO.description,
    keywords: DEFAULT_ROUTE_SEO.keywords,
    robots: 'noindex, follow',
    canonicalPath,
  };
}
