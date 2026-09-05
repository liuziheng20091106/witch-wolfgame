import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
const appVersion = process.env.npm_package_version ?? '2.4.0';

const publicShell = [
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

function serviceWorkerPlugin(): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = [...new Set(['./index.html', ...publicShell, ...Object.keys(bundle).map((file) => `./${file}`)])];
      const hash = createHash('sha256');
      for (const [fileName, output] of Object.entries(bundle)) {
        hash.update(fileName);
        hash.update(output.type === 'chunk' ? output.code : output.source);
      }
      for (const file of publicShell) hash.update(readFileSync(resolve('public', file.slice(2))));
      hash.update(readFileSync(resolve('index.html')));
      const buildId = hash.digest('hex').slice(0, 12);
      const cacheName = `majo-wolf-${appVersion}-${buildId}`;
      const source = `const CACHE_NAME = ${JSON.stringify(cacheName)};
const CACHE_PREFIX = 'majo-wolf-';
const PRECACHE_FILES = ${JSON.stringify(files)};
const scopeUrl = self.registration.scope;
const indexUrl = new URL('./index.html', scopeUrl).href;
const precacheUrls = new Set(PRECACHE_FILES.map((file) => new URL(file, scopeUrl).href));

self.addEventListener('install', (event) => {
  const requests = [...precacheUrls].map((url) => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(requests)));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((names) => Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    const scope = new URL(scopeUrl);
    event.respondWith(url.pathname === scope.pathname
      ? fetch(new Request(request, { cache: 'reload' })).catch(() => caches.match(indexUrl))
      : Promise.resolve(Response.redirect(scopeUrl, 302)));
    return;
  }

  url.search = '';
  if (!precacheUrls.has(url.href)) return;
  event.respondWith(caches.match(url.href).then((cached) => cached ?? fetch(request)));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), serviceWorkerPlugin()],
  server: {
    proxy: {
      '/multiplayer': {
        target: 'ws://127.0.0.1:34022',
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