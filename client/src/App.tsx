import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/layout/Layout';
import { applyRouteSeo } from './seo/routeSeo';

const TEST_PAGE_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_PAGE === 'true';
const GA_MEASUREMENT_ID = 'G-M9KRSSN3BB';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const BlocksPage = lazy(() => import('./pages/BlocksPage'));
const BlockDetailPage = lazy(() => import('./pages/BlockDetailPage'));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage'));
const TransactionPage = lazy(() => import('./pages/TransactionPage'));
const AddressPage = lazy(() => import('./pages/AddressPage'));
const RichListPage = lazy(() => import('./pages/RichListPage'));
const MiningPage = lazy(() => import('./pages/MiningPage'));
const BubblemapsPage = lazy(() => import('./pages/BubblemapsPage'));
const NetworkPage = lazy(() => import('./pages/NetworkPage'));
const NetworkHealthPage = lazy(() => import('./pages/NetworkHealthPage'));
const MasternodesPage = lazy(() => import('./pages/MasternodesPage'));
const ProviderTagsPage = lazy(() => import('./pages/ProviderTagsPage'));
const MasternodeHealthPage = lazy(() => import('./pages/MasternodeHealthPage'));
const BanDetectionPage = lazy(() => import('./pages/BanDetectionPage'));
const PosePenaltyWatchPage = lazy(() => import('./pages/PosePenaltyWatchPage'));
const NodeInventoryPage = lazy(() => import('./pages/NodeInventoryPage'));
const NetworkNoisePage = lazy(() => import('./pages/NetworkNoisePage'));
const MempoolPage = lazy(() => import('./pages/MempoolPage'));
const ApiPage = lazy(() => import('./pages/ApiPage'));
const TestPage = TEST_PAGE_ENABLED ? lazy(() => import('./pages/TestPage')) : null;
const AboutPage = lazy(() => import('./pages/AboutPage'));
const SearchResultsPage = lazy(() => import('./pages/SearchResultsPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

function PageFallback() {
  return (
    <div className="skeleton-page" role="status" aria-live="polite">
      <div className="skeleton skeleton-title" />
      <div className="skeleton-stats">
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
      </div>
      <div className="skeleton skeleton-table" />
    </div>
  );
}

function withSuspense(page: ReactNode) {
  return <Suspense fallback={<PageFallback />}>{page}</Suspense>;
}

/** Old /searchv2 links keep working: the query moves to /search, which opens the object's own page. */
function LegacySearchRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/search', search }} replace />;
}

export default function App() {
  const location = useLocation();

  useEffect(() => {
    const maybeGtag = (window as Window & { gtag?: (...args: unknown[]) => void }).gtag;
    if (typeof maybeGtag !== 'function') return;
    const pagePath = `${location.pathname}${location.search}${location.hash}`;
    maybeGtag('config', GA_MEASUREMENT_ID, { page_path: pagePath });
  }, [location.hash, location.pathname, location.search]);

  useEffect(() => {
    applyRouteSeo(location.pathname);
  }, [location.pathname]);

  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={withSuspense(<DashboardPage />)} />
        <Route path="blocks" element={withSuspense(<BlocksPage />)} />
        <Route path="txs" element={withSuspense(<TransactionsPage />)} />
        <Route path="block/:hashOrHeight" element={withSuspense(<BlockDetailPage />)} />
        <Route path="tx/:txid" element={withSuspense(<TransactionPage />)} />
        <Route path="address/:address" element={withSuspense(<AddressPage />)} />
        <Route path="richlist" element={withSuspense(<RichListPage />)} />
        <Route path="wallets" element={<Navigate to="/richlist" replace />} />
        <Route path="mining" element={withSuspense(<MiningPage />)} />
        <Route path="bubblemaps" element={withSuspense(<BubblemapsPage />)} />
        <Route path="network" element={withSuspense(<NetworkPage />)} />
        <Route path="chain-health" element={withSuspense(<NetworkHealthPage />)} />
        <Route path="crawler" element={<Navigate to="/chain-health" replace />} />
        <Route path="masternodes" element={withSuspense(<MasternodesPage />)} />
        <Route path="provider-tags" element={withSuspense(<ProviderTagsPage />)} />
        <Route path="devtools/provider-tags" element={<Navigate to="/provider-tags" replace />} />
        <Route path="devtools/pose-penalty" element={withSuspense(<PosePenaltyWatchPage />)} />
        <Route path="devtools/node-inventory" element={withSuspense(<NodeInventoryPage />)} />
        <Route path="devtools/network-noise" element={withSuspense(<NetworkNoisePage />)} />
        <Route path="mn-health" element={withSuspense(<MasternodeHealthPage />)} />
        <Route path="ban-detection" element={withSuspense(<BanDetectionPage />)} />
        <Route path="mempool" element={withSuspense(<MempoolPage />)} />
        <Route path="api" element={withSuspense(<ApiPage />)} />
        {TEST_PAGE_ENABLED && TestPage && <Route path="test" element={withSuspense(<TestPage />)} />}
        <Route path="about" element={withSuspense(<AboutPage />)} />
        <Route path="search" element={withSuspense(<SearchResultsPage />)} />
        <Route path="searchv2" element={<LegacySearchRedirect />} />
        <Route path="*" element={withSuspense(<NotFoundPage />)} />
      </Route>
    </Routes>
  );
}
