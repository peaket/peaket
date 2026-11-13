'use client';
// 월렛 오프라인 배너(SCR-013, offline-gate §1·§3). 실제 연결 상태와 IndexedDB의 마지막 동기화 시각을 보여 준다.
// 미리보기 상태(?state=오프라인)는 forceOffline으로 같은 배너를 그린다. 서비스 워커가 셸을 열어도 이 배너가 먼저 보인다.
import { useEffect, useState } from 'react';
import { loadLastSyncedAt } from '../store';

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

  if (!forceOffline && online) return null;

  const lastSync = lastSyncedAt ? KST.format(new Date(lastSyncedAt)) : fallbackLastSyncText;
  return (
    <div className="banner banner-offline banner-strip md:px-6 lg:px-8" role="status" id="off-msg">
      <i className="ic ic-wifi-off" aria-hidden="true" />
      <div className="banner-body">
        오프라인입니다. {lastSync ? `마지막 동기화 ${lastSync} · ` : ''}QR은 그대로 표시됩니다
      </div>
    </div>
  );
}
