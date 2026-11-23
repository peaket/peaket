'use client';
// 월렛 실제 화면(WalletLive)이 쓰는 지연 조각만 모은다. 퍼블리싱 부품(WalletClient)은 WebShell 등 무거운 것을 함께 가져오므로
// 실제 화면 경로에서 빼 첫 화면 JS를 줄인다(docs/frontend.md §5.8, CI 실행 45240606103).
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { DeviceQrProps } from '@/features/wallet-device-key/ui/DeviceQr';
import type { OfflineBannerProps } from '@/features/wallet-device-key/ui/OfflineBanner';
import { afterLoad } from '@/shared/lib/after-load';

// next/dynamic의 런타임을 첫 묶음에 넣지 않으려고 import()와 상태만 쓴다(R-562, BAT-177).
function useLazyComponent<P>(load: () => Promise<ComponentType<P>>): ComponentType<P> | null {
  const [Component, setComponent] = useState<ComponentType<P> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const cancel = afterLoad(() => {
      void load()
        .then((loaded) => {
          if (!cancelled) setComponent(() => loaded);
        })
        .catch(() => {
          // 청크를 받지 못하면 화면을 막지 않는다. 다음 방문에서 다시 시도한다.
        });
    });
    return () => {
      cancelled = true;
      cancel();
    };
  }, [load]);
  return Component;
}

const loadDeviceQr = () => import('@/features/wallet-device-key/ui/DeviceQr').then((m) => m.DeviceQr);
const loadOfflineBanner = () => import('@/features/wallet-device-key/ui/OfflineBanner').then((m) => m.OfflineBanner);

export function DeviceQrLazy({ fallback, ...props }: DeviceQrProps & { fallback?: ReactNode }) {
  const Component = useLazyComponent(loadDeviceQr);
  if (!Component) return <>{fallback}</>;
  return <Component {...props} />;
}

export type OfflineBannerLazyProps = OfflineBannerProps;

export function OfflineBannerLazy(props: OfflineBannerLazyProps) {
  const Component = useLazyComponent(loadOfflineBanner);
  if (!Component) return <div style={{ height: 40 }} aria-hidden="true" />;
  return <Component {...props} />;
}
