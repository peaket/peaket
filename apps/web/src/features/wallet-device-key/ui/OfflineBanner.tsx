'use client';
// 월렛 오프라인 배너(SCR-013, offline-gate §1·§3). 실제 연결 상태와 IndexedDB의 마지막 동기화 시각을 보여 준다.
// 미리보기 상태(?state=오프라인)는 forceOffline으로 같은 배너를 그린다. 서비스 워커가 셸을 열어도 이 배너가 먼저 보인다.
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { loadLastSyncedAt } from '../store';

interface SerwistProviderProps {
  swUrl: string;
  disable?: boolean;
  cacheOnNavigation?: boolean;
  options?: { scope?: string };
  children?: ReactNode;
}

/** 월렛 서비스 워커를 이 화면이 마운트된 뒤 별도 덩어리로 등록한다(루트 문서·첫 화면 번들에서 뺀다, R-562). */
function WalletPwa() {
  const [Provider, setProvider] = useState<ComponentType<SerwistProviderProps> | null>(null);
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') return;
    let cancelled = false;
    void import('@serwist/turbopack/react')
      .then((m) => {
        if (!cancelled) setProvider(() => m.SerwistProvider as unknown as ComponentType<SerwistProviderProps>);
      })
      .catch(() => {
        // 등록 실패는 화면을 막지 않는다. 다음 방문에서 다시 시도한다.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // 스크립트 캐시는 서비스 워커의 precache manifest(빌드의 모든 청크)가 맡는다(R-563).
  // 화면이 받은 스크립트를 다시 보내는 CACHE_URLS는 매 방문 100여 개를 다시 받아
  // LCP 이미지와 네트워크를 다퉈 두 번째 방문부터 LCP를 8초대로 밀어 올렸다.
  if (!Provider) return null;
  return <Provider swUrl="/serwist/sw.js" cacheOnNavigation={false} options={{ scope: '/my/tickets' }} />;
}

const KST = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export interface OfflineBannerProps {
  /** 미리보기 상태를 오프라인으로 강제한다 */
  forceOffline?: boolean;
  /** 저장된 동기화 시각이 없을 때 보일 글(퍼블리싱 보드 값) */
  fallbackLastSyncText?: string;
}

export function OfflineBanner({ forceOffline = false, fallbackLastSyncText }: OfflineBannerProps) {
  const [online, setOnline] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | undefined>(undefined);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    void loadLastSyncedAt().then(setLastSyncedAt);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // 배너가 나타나고 사라져도 아래 QR이 밀리지 않게 자리를 늘 40px 잡아 둔다(R-562, CLS).
  if (!forceOffline && online) {
    return (
      <>
        <WalletPwa />
        <div style={{ height: 40 }} aria-hidden="true" />
      </>
    );
  }

  const lastSync = lastSyncedAt ? KST.format(new Date(lastSyncedAt)) : fallbackLastSyncText;
  return (
    <>
      <WalletPwa />
      <div style={{ height: 40, overflow: 'hidden' }}>
        <div className="banner banner-offline banner-strip md:px-6 lg:px-8" role="status" id="off-msg" style={{ height: 40 }}>
          <i className="ic ic-wifi-off" aria-hidden="true" />
          <div className="banner-body" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            오프라인입니다. {lastSync ? `마지막 동기화 ${lastSync} · ` : ''}QR은 그대로 표시됩니다
          </div>
        </div>
      </div>
    </>
  );
}
