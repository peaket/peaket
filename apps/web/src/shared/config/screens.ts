// 소비자 웹 화면 목록(/preview, 개발 서버에서만). 세 담당의 등록 파일을 합친다. 각 담당은 자기 파일만 고친다.
import { ORIGINS } from './origins';
import { ACCOUNT_SCREENS } from './screens.account';
import { BOOKING_SCREENS } from './screens.booking';
import { DISCOVERY_SCREENS } from './screens.discovery';
import { GROUP_LABEL, type WebScreen } from './screens.types';

const scrNo = (s: WebScreen) => Number(s.id.replace(/\D/g, ''));

/** SCR 번호 순(같은 번호는 등록 순서) */
export const WEB_SCREENS: readonly WebScreen[] = [...DISCOVERY_SCREENS, ...ACCOUNT_SCREENS, ...BOOKING_SCREENS]
  .map((s, i) => ({ s, i }))
  .sort((a, b) => scrNo(a.s) - scrNo(b.s) || a.i - b.i)
  .map(({ s }) => ({ ...s, note: [GROUP_LABEL[s.group], s.note].filter(Boolean).join(' · ') }));

/** 화면 목록 위에 두는 다른 앱 미리보기 링크 */
export const OTHER_APP_PREVIEWS: readonly { name: string; href: string }[] = [
  { name: '대기실 경량 페이지 · 3004', href: `${ORIGINS.queueRoom}/preview` },
  { name: '파트너 콘솔 · 3001', href: `${ORIGINS.partner}/preview` },
  { name: '관제 콘솔 · 3002', href: `${ORIGINS.console}/preview` },
  { name: '스캐너 · 3003', href: `${ORIGINS.scanner}/preview` },
  { name: '포렌식 데모 · 3005', href: `${ORIGINS.forensics}/preview` },
];

export type { WebScreen, ScreenGroup, ScreenOwner } from './screens.types';
