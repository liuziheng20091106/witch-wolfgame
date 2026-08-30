import { useCallback, useEffect, useState } from 'react';

interface ServiceWorkerState {
  offline: boolean;
  updateReady: boolean;
  applyUpdate(): void;
}

export function useServiceWorker(): ServiceWorkerState {
  const [offline, setOffline] = useState(() => !navigator.onLine);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    const updateNetworkState = () => setOffline(!navigator.onLine);
    window.addEventListener('online', updateNetworkState);
    window.addEventListener('offline', updateNetworkState);
    return () => {
      window.removeEventListener('online', updateNetworkState);
      window.removeEventListener('offline', updateNetworkState);
    };
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;

    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;
    let installingWorker: ServiceWorker | null = null;

    const showWaitingWorker = () => {
      if (!disposed && registration?.waiting) setWaitingWorker(registration.waiting);
    };
    const watchInstallingWorker = () => {
      installingWorker?.removeEventListener('statechange', showWaitingWorker);
      installingWorker = registration?.installing ?? null;
      installingWorker?.addEventListener('statechange', showWaitingWorker);
      showWaitingWorker();
    };
    const checkForUpdate = () => {
      if (document.visibilityState === 'visible') void registration?.update();
    };

    const appRoot = new URL('../', import.meta.url);
    void navigator.serviceWorker.register(new URL('sw.js', appRoot), { scope: appRoot.href })
      .then((nextRegistration) => {
        if (disposed) return;
        registration = nextRegistration;
        registration.addEventListener('updatefound', watchInstallingWorker);
        watchInstallingWorker();
        checkForUpdate();
      })
      .catch((error: unknown) => console.error('Service Worker 注册失败', error));

    document.addEventListener('visibilitychange', checkForUpdate);

    return () => {
      disposed = true;
      installingWorker?.removeEventListener('statechange', showWaitingWorker);
      registration?.removeEventListener('updatefound', watchInstallingWorker);
      document.removeEventListener('visibilitychange', checkForUpdate);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (!waitingWorker) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }, [waitingWorker]);

  return { offline, updateReady: waitingWorker !== null, applyUpdate };
}
