import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const appVersion = process.env.npm_package_version ?? '2.1.0';

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
});
