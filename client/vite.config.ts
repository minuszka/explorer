import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { execFileSync } from 'node:child_process';

// The footer describes the commit this bundle was built from, i.e. what is running.
function readGit(args: string[]): string {
  try {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

function resolveGitCommitDate(): string {
  const parsed = Date.parse(readGit(['log', '-1', '--format=%cI']));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : 'unknown';
}

function resolveBuildMeta() {
  const date = new Date().toISOString();
  const stamp = date.replace(/[^0-9]/g, '').slice(0, 14);
  const shortHash = readGit(['rev-parse', '--short', 'HEAD']) || 'nogit';
  const commitTitle = readGit(['log', '-1', '--format=%s']) || 'unknown commit';
  const commitDate = resolveGitCommitDate();

  return {
    id: `${shortHash}-${stamp}`,
    shortHash,
    commitTitle,
    commitDate,
    date,
  };
}

const buildMeta = resolveBuildMeta();

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildMeta.id),
    __BUILD_META__: JSON.stringify(buildMeta),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@defcon/shared': path.resolve(__dirname, '../shared/src/index.ts'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Keep react core together for stable long-term browser caching.
            if (
              id.includes('/react/') ||
              id.includes('\\react\\') ||
              id.includes('/react-dom/') ||
              id.includes('\\react-dom\\') ||
              id.includes('/react-router-dom/') ||
              id.includes('\\react-router-dom\\')
            ) {
              return 'react';
            }

            // Query client separate cache bucket.
            if (id.includes('/@tanstack/react-query/') || id.includes('\\@tanstack\\react-query\\')) {
              return 'query';
            }

            // Bubblemaps 3D stack is heavy and route-specific.
            if (
              id.includes('/react-force-graph-2d/') ||
              id.includes('\\react-force-graph-2d\\') ||
              id.includes('/three/') ||
              id.includes('\\three\\') ||
              id.includes('/3d-force-graph/') ||
              id.includes('\\3d-force-graph\\')
            ) {
              return 'forcegraph';
            }
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
