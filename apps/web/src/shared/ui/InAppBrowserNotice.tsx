'use client';
// SCR-058 인앱 브라우저 안내(대기실·티켓 입장용 등록 직전, d5 §5.32, NFR-019).
// 서버 첫 그리기에는 User-Agent를 읽지 않으므로 안내가 없다. 클라이언트가 붙은 뒤 인앱 브라우저일 때만 보인다.
import { useEffect, useState } from 'react';
import { detectInAppBrowser, openInBrowserHref } from '@/shared/lib/in-app-browser';

export function InAppBrowserNotice({ next, className }: { next: string; className?: string }) {
  const [inApp, setInApp] = useState(false);
  useEffect(() => {
    setInApp(detectInAppBrowser(navigator.userAgent) !== null);
  }, []);
  if (!inApp) return null;
  return (
    <p className={className ?? 't-sm'}>
      지금은 앱 안의 브라우저입니다. 입장용 등록과 QR은 외부 브라우저에서 열어 주세요.{' '}
      <a className="link-more" href={openInBrowserHref(next)}>
        외부 브라우저로 열기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </a>
    </p>
  );
}
