import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const appVersion = process.env.npm_package_version ?? '2.4.0';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    proxy: {
      '/multiplayer': {
        target: 'ws://127.0.0.1:34024',
        ws: true,
      },
    },
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
});
