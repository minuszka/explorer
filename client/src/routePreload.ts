// Route-chunk preloading for header navigation. Hovering (or focusing) a nav
// link starts downloading that page's lazy chunk, so by the time the user
// clicks, the code is usually already in the module cache. import() of the
// same module is deduped by the browser, so repeat calls are free — these MUST
// stay the same module specifiers App.tsx uses for its lazy() routes.
const ROUTE_PRELOADERS: Record<string, () => Promise<unknown>> = {
  '/': () => import('./pages/DashboardPage'),
  '/blocks': () => import('./pages/BlocksPage'),
  '/txs': () => import('./pages/TransactionsPage'),
  '/richlist': () => import('./pages/RichListPage'),
  '/mining': () => import('./pages/MiningPage'),
  '/network': () => import('./pages/NetworkPage'),
  '/chain-health': () => import('./pages/NetworkHealthPage'),
  '/masternodes': () => import('./pages/MasternodesPage'),
  '/provider-tags': () => import('./pages/ProviderTagsPage'),
  '/ban-detection': () => import('./pages/BanDetectionPage'),
  '/devtools/pose-penalty': () => import('./pages/PosePenaltyWatchPage'),
  '/devtools/node-inventory': () => import('./pages/NodeInventoryPage'),
  '/devtools/network-noise': () => import('./pages/NetworkNoisePage'),
  '/api': () => import('./pages/ApiPage'),
  '/about': () => import('./pages/AboutPage'),
};

export function preloadRoute(path: string): void {
  const preloader = ROUTE_PRELOADERS[path];
  if (!preloader) return;
  // Swallow failures (e.g. offline) — navigation will retry via lazy().
  void preloader().catch(() => {});
}
