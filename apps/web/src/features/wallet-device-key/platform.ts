// '이 휴대폰을 입장용으로 등록'을 누르기 전에 가를 기기 종류(ADR-0363 결정 10, offline-gate §2·§4, docs/frontend.md §5.4 '입장용 휴대폰 등록', O-T32·O-T50).
// - iOS·iPadOS 브라우저 탭(홈 화면 앱이 아님: `display-mode: standalone`도 `navigator.standalone`도 아님): 키를 만들기 전에 "홈 화면에 추가한 앱에서 등록하세요"와
//   [ 방법 보기 ]·( 그래도 이 브라우저에 등록 › )를 보인다. 홈 화면 앱이면 안내 없이 등록한다.
// - 데스크톱으로 보이는 브라우저: "입장 QR은 휴대폰에서 등록하세요"와 ( 그래도 이 기기에 등록 › )(같은 꼴).
// - 인앱 브라우저: SCR-058(외부 브라우저 안내)로 보낸다(shared/lib/in-app-browser.ts).
// 판별에 쓰는 값(사용자 에이전트·표시 방식·터치 점 수·포인터)은 주입한다(시험이 바꿔 가며 부른다).
import { isInAppBrowser } from '../../shared/lib/in-app-browser.ts';

export type EnrollPlatform = 'in-app' | 'ios-tab' | 'ios-standalone' | 'desktop' | 'mobile';

export interface PlatformSignals {
  userAgent: string;
  /** matchMedia('(display-mode: standalone)').matches */
  displayStandalone: boolean;
  /** iOS Safari 옛 표식 navigator.standalone */
  navigatorStandalone?: boolean;
  /** navigator.maxTouchPoints(iPadOS는 데스크톱 Safari 꼴 사용자 에이전트를 내므로 터치 점으로 가른다) */
  maxTouchPoints?: number;
  /** matchMedia('(pointer: coarse)').matches */
  coarsePointer?: boolean;
}

const IOS = /iPhone|iPad|iPod/i;
const MAC = /Macintosh/i;
const MOBILE = /Android|Mobile|iPhone|iPad|iPod|Windows Phone/i;

export function enrollPlatformOf(s: PlatformSignals): EnrollPlatform {
  if (isInAppBrowser(s.userAgent)) return 'in-app';
  const ipadAsMac = MAC.test(s.userAgent) && (s.maxTouchPoints ?? 0) > 1;
  if (IOS.test(s.userAgent) || ipadAsMac) return s.displayStandalone || s.navigatorStandalone === true ? 'ios-standalone' : 'ios-tab';
  if (!MOBILE.test(s.userAgent) && s.coarsePointer !== true) return 'desktop';
  return 'mobile';
}

/** 등록 전에 안내를 먼저 보일 기기인가(iOS 탭·데스크톱). ( 그래도 … 등록 › )을 누르면 그 탭에서는 다시 묻지 않는다 */
export const needsEnrollGuide = (p: EnrollPlatform): p is 'ios-tab' | 'desktop' => p === 'ios-tab' || p === 'desktop';

/** 브라우저에서 지금 신호를 읽는다(SSR이면 'mobile'로 보아 안내 없이 버튼만 그린다) */
export function browserPlatformSignals(): PlatformSignals | undefined {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return undefined;
  const media = (q: string) => (typeof window.matchMedia === 'function' ? window.matchMedia(q).matches : false);
  return {
    userAgent: navigator.userAgent,
    displayStandalone: media('(display-mode: standalone)'),
    navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    coarsePointer: media('(pointer: coarse)'),
  };
}
