'use client';
// SCR-058 인앱 브라우저 안내(대기실·티켓 입장용 등록 직전, d5 §5.32, NFR-019).
// 서버 첫 그리기에는 User-Agent를 읽지 않으므로 안내가 없다. 클라이언트가 붙은 뒤 인앱 브라우저일 때만 보인다.
import { useEffect, useState } from 'react';
import type * as InAppBrowser from '@/shared/lib/in-app-browser';

export function InAppBrowserNotice({ next, className }: { next: string; className?: string }) {
  const [helpers, setHelpers] = useState<typeof InAppBrowser | null>(null);
  const [inApp, setInApp] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // UA 판별 코드는 인앱 브라우저일 때만 필요하다. 첫 화면 번들에서 빼고 마운트 뒤 받는다(R-562).
    void import('@/shared/lib/in-app-browser').then((m) => {
      if (cancelled) return;
      setHelpers(m);
      setInApp(m.detectInAppBrowser(navigator.userAgent) !== null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!inApp || !helpers) return null;
  return (
    <p className={className ?? 't-sm'}>
      지금은 앱 안의 브라우저입니다. 입장용 등록과 QR은 외부 브라우저에서 열어 주세요.{' '}
      <a className="link-more" href={helpers.openInBrowserHref(next)}>
        외부 브라우저로 열기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </a>
    </p>
  );
}
