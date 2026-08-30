/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface Window {
  exportCurrentGame(): void;
}

interface ImportMetaEnv {
  readonly VITE_MAIN_BACKEND_ENDPOINT?: string;
  readonly VITE_MULTIPLAYER_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
