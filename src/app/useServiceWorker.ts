import { useCallback, useEffect, useRef, useState } from 'react';

interface ServiceWorkerState {
  offline: boolean;
  updateReady: boolean;
  applyUpdate(): void;
}

export function useServiceWorker(): ServiceWorkerState {
  const [offline, setOffline] = useState(() => !navigator.onLine);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const applyingUpdateRef = useRef(false);

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

    const syncWaitingWorker = () => {
      const nextWaitingWorker = registration?.waiting ?? null;
      if (!nextWaitingWorker) applyingUpdateRef.current = false;
      if (!disposed) setWaitingWorker(nextWaitingWorker);
    };
    const watchInstallingWorker = () => {
      installingWorker?.removeEventListener('statechange', syncWaitingWorker);
      installingWorker = registration?.installing ?? null;
      installingWorker?.addEventListener('statechange', syncWaitingWorker);
      syncWaitingWorker();
    };
    const clearWaitingWorker = () => {
      applyingUpdateRef.current = false;
      if (!disposed) setWaitingWorker(null);
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

    navigator.serviceWorker.addEventListener('controllerchange', clearWaitingWorker);
    document.addEventListener('visibilitychange', checkForUpdate);

    return () => {
      disposed = true;
      installingWorker?.removeEventListener('statechange', syncWaitingWorker);
      registration?.removeEventListener('updatefound', watchInstallingWorker);
      document.removeEventListener('visibilitychange', checkForUpdate);
      navigator.serviceWorker.removeEventListener('controllerchange', clearWaitingWorker);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (!waitingWorker || applyingUpdateRef.current) return;
    applyingUpdateRef.current = true;
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }, [waitingWorker]);

  return { offline, updateReady: waitingWorker !== null, applyUpdate };
}
