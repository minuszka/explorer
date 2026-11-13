import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AutoRefreshProvider } from './context/AutoRefreshContext';
import { queryClient } from './queryClient';
// Self-hosted fonts: the production CSP only allows fonts and stylesheets from this origin.
import '@fontsource-variable/space-grotesk/wght.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './styles/globals.css';
import { readBootData } from './utils/bootData';
import { watchChunkFailures } from './utils/releaseReload';

watchChunkFailures();

// Server-injected first-paint data (see buildBootScript in server/src/index.ts).
// Seeded with updatedAt: 0 so it renders instantly but is treated as stale —
// React Query revalidates it in the background right after mount.
const boot = readBootData();
if (boot?.stats) {
  queryClient.setQueryData(['stats'], boot.stats, { updatedAt: 0 });
}
if (boot?.dashboardOverview) {
  queryClient.setQueryData(['dashboard-overview'], boot.dashboardOverview, { updatedAt: 0 });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AutoRefreshProvider>
          <App />
        </AutoRefreshProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
