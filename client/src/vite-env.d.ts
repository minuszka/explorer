/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_ENABLE_TEST_PAGE?: string;
  readonly VITE_PUBLIC_SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __BUILD_ID__: string;
declare const __BUILD_META__: { id: string; shortHash: string; commitTitle: string; commitDate: string; date: string };
