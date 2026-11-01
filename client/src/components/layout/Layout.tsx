import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './Header';
import Footer from './Footer';
import RouteErrorBoundary, { ReloadPageButton } from './RouteErrorBoundary';
import StatePanel from '../ui/StatePanel';
import { reloadAfterChunkFailure } from '../../utils/releaseReload';

export default function Layout() {
  const { key, pathname } = useLocation();
  const [chunkFailed, setChunkFailed] = useState(false);

  // A chunk can fail without any page error: Vite retries a failed stylesheet no second
  // time, so its page opens unstyled. Offer a reload as soon as the failure is known.
  useEffect(() => {
    const noteFailure = () => setChunkFailed(true);
    window.addEventListener('vite:preloadError', noteFailure);
    return () => window.removeEventListener('vite:preloadError', noteFailure);
  }, []);

  // A failed hover preload leaves this page working, so the tab catches up when it moves
  // to another page. A new query alone stays on the loaded page and needs no chunk, and
  // a reload would throw away the filters and state the visitor has there.
  useEffect(() => {
    reloadAfterChunkFailure();
  }, [pathname]);

  return (
    <>
      <Header />
      <main className="container page app-main">
        <RouteErrorBoundary resetKey={key}>
          {chunkFailed && (
            <div role="status">
              <StatePanel
                className="route-reload-notice"
                tone="warning"
                title="Part of the site could not be loaded"
                description="The site may have been updated since this tab was opened, or the connection dropped."
                action={<ReloadPageButton />}
              />
            </div>
          )}
          <Outlet />
        </RouteErrorBoundary>
      </main>
      <Footer />
    </>
  );
}
