import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider, applyThemeAttribute, resolveInitialTheme } from './context/ThemeContext';
import { AutoRefreshProvider } from './context/AutoRefreshContext';
import { queryClient } from './queryClient';
import './styles/globals.css';
import { readBootData } from './utils/bootData';
import { watchChunkFailures } from './utils/releaseReload';

applyThemeAttribute(resolveInitialTheme());
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
        <ThemeProvider>
          <AutoRefreshProvider>
            <App />
          </AutoRefreshProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
