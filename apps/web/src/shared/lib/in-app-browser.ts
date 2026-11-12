// 인앱 브라우저 감지와 외부 브라우저 안내(SCR-058, d5 §5.32, NFR-019).
// 대기실·티켓 입장용 등록은 인앱 브라우저에서 동작이 다르므로, 알려진 인앱 브라우저면
// `/open-in-browser?next=<같은 출처 경로>`로 먼저 보낸다. `next`는 safeNext()로 검사해 열린 이동을 막는다.
import { safeNext } from './safe-next.ts';

export type InAppBrowser = 'KAKAO' | 'INSTAGRAM' | 'FACEBOOK' | 'NAVER' | 'LINE' | 'BAND' | 'TIKTOK' | 'X';

/** 알려진 인앱 브라우저의 User-Agent 표식. 일반 WebView(`; wv)`)는 앱을 알 수 없어 넣지 않는다 */
const PATTERNS: ReadonlyArray<readonly [InAppBrowser, RegExp]> = [
  ['KAKAO', /KAKAOTALK/i],
  ['INSTAGRAM', /Instagram/i],
  ['FACEBOOK', /FBAN|FBAV|FB_IAB/i],
  ['NAVER', /NAVER\(inapp|NaverWebview/i],
  ['LINE', /Line\//i],
  ['BAND', /Band\//i],
  ['TIKTOK', /musical_ly|BytedanceWebview|TikTok/i],
  ['X', /Twitter/i],
];

/** User-Agent에서 알려진 인앱 브라우저를 찾는다. 없으면 null */
export function detectInAppBrowser(userAgent: string | null | undefined): InAppBrowser | null {
  if (!userAgent) return null;
  for (const [name, pattern] of PATTERNS) if (pattern.test(userAgent)) return name;
  return null;
}

/** 인앱 브라우저면 true */
export function isInAppBrowser(userAgent: string | null | undefined): boolean {
  return detectInAppBrowser(userAgent) !== null;
}

/** SCR-058 안내 화면 주소. `next`가 안전하지 않으면 첫 화면(`/`)으로 보낸다 */
export function openInBrowserHref(next: string): string {
  const safe = safeNext(next);
  return safe === '/' ? '/' : `/open-in-browser?next=${encodeURIComponent(safe)}`;
}

/**
 * 대기실·티켓으로 가는 주소. 인앱 브라우저면 SCR-058 안내를 먼저 거친다.
 * 서버 첫 그리기에서는 `userAgent`가 없어 원래 주소를 쓰고, 클라이언트가 붙은 뒤 바뀐다(하이드레이션 불일치 없음).
 */
export function entryHref(next: string, userAgent: string | null | undefined): string {
  return isInAppBrowser(userAgent) ? openInBrowserHref(next) : next;
}
