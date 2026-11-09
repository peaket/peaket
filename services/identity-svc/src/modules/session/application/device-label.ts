// 로그인한 기기의 화면용 이름(docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현', ADR-0209 결정 1, I-T76).
// User-Agent(브라우저가 스스로 알리는 이름표 글)에서 정해진 낱말의 '브라우저 · 운영체제'만 뽑는다. 원문의 글자(판 번호·모델명)는 옮기지 않는다.
// 브라우저 계열은 정규 로그 줄의 client와 같은 판별(@peaket/platform browserFamily)을 쓴다. 판별 규칙을 한 곳에 둔다(BOT-044 새 맥락 리뷰 낮음 8).
// 그 판별이 모르는 앱 안 브라우저(카카오톡·네이버 앱)는 먼저 본다. 둘 다 Chrome·Safari 표기를 함께 달기 때문이다.
import { type BrowserFamily, browserFamily } from '@peaket/platform';

/** 앱 서버가 보내는 값의 상한과 같다(앞 512자만 본다, 정규식 비용을 묶는다. platform 판별도 같은 상한이다) */
const MAX_UA = 512;

const IN_APP: ReadonlyArray<readonly [RegExp, string]> = [
  [/KAKAOTALK/i, '카카오톡'],
  [/NAVER\(inapp/i, '네이버 앱'],
];

const BROWSER_NAME: Readonly<Record<BrowserFamily, string>> = {
  edge: 'Edge',
  samsung: 'Samsung Internet',
  whale: 'Whale',
  opera: 'Opera',
  firefox: 'Firefox',
  chrome: 'Chrome',
  safari: 'Safari',
};

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows NT\b|\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMacintosh\b|\bMac OS X\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

const pick = (ua: string, rules: ReadonlyArray<readonly [RegExp, string]>): string | null => rules.find(([re]) => re.test(ua))?.[1] ?? null;

/** '브라우저 · 운영체제'. 둘 다 모르면 null, 하나만 알면 그것만 */
export function deviceLabelOf(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, MAX_UA);
  const family = browserFamily(ua);
  const browser = pick(ua, IN_APP) ?? (family ? BROWSER_NAME[family] : null);
  const parts = [browser, pick(ua, SYSTEMS)].filter((x): x is string => x !== null);
  return parts.length ? parts.join(' · ') : null;
}
