// 화면 목록(/preview) 등록 파일 A: 골격 담당 화면(SCR-020·062·063·021·022·023). 상태 목록은 shared/config/states/의 상수를 그대로 쓴다.
import type { PreviewScreen } from '@peaket/ds/Preview';
import { PRIMARY_PRODUCTION_ID } from '@/entities/production';
import { routes } from '@/shared/config/routes';
import { INVITE_STATES, LOGIN_STATES, UNLOCK_STATES } from '@/shared/config/states/scr020-auth';
import { ACCOUNT_STATES, PAYOUT_STATES, SELLER_STATES, TEAM_STATES } from '@/shared/config/states/scr020-settings';
import { HOME_STATES } from '@/shared/config/states/scr062';
import { OVERVIEW_STATES } from '@/shared/config/states/scr063';
import { EDIT_WIZARD_STATES, NEW_WIZARD_STATES, SALE_REVIEW_STATES } from '@/shared/config/states/scr021';
import { SEATMAP_STATES } from '@/shared/config/states/scr022';
import { PRODUCT_STATES } from '@/shared/config/states/scr023';

const EVT = PRIMARY_PRODUCTION_ID;

export const screensA: readonly PreviewScreen[] = [
  { id: 'SCR-020', name: '파트너 로그인', path: routes.login(), states: LOGIN_STATES, note: '셸 없는 가운데 카드' },
  { id: 'SCR-020', name: '파트너 초대 수락', path: routes.invite(), states: INVITE_STATES, note: '실제 주소는 /invite#token=' },
  { id: 'SCR-020', name: '계정 잠금 풀기', path: routes.unlock(), states: UNLOCK_STATES, note: '실제 주소는 /unlock#token=' },
  { id: 'SCR-020', name: '설정 › 내 계정', path: routes.settingsAccount(), states: ACCOUNT_STATES },
  { id: 'SCR-020', name: '설정 › 판매자 정보', path: routes.settingsSeller(), states: SELLER_STATES },
  { id: 'SCR-020', name: '설정 › 정산 계좌', path: routes.settingsPayout(), states: PAYOUT_STATES, note: '?role=member로 실무자 보기' },
  { id: 'SCR-020', name: '설정 › 팀 계정', path: routes.settingsTeam(), states: TEAM_STATES },
  { id: 'SCR-062', name: '파트너 홈·공연 목록', path: routes.events(), states: HOME_STATES },
  { id: 'SCR-063', name: '공연 개요(회차 허브)', path: routes.event(EVT), states: OVERVIEW_STATES },
  { id: 'SCR-021', name: '공연 등록 위저드(새 공연)', path: routes.eventNew(), states: NEW_WIZARD_STATES },
  { id: 'SCR-021', name: '공연 등록 위저드(등록 정보 고치기)', path: routes.eventTab('evt-autumn-fest', 'edit'), states: EDIT_WIZARD_STATES },
  { id: 'SCR-021', name: '공연 등록 위저드(5단계 판매 승인 요청)', path: routes.eventSaleReview('evt-autumn-fest'), states: SALE_REVIEW_STATES },
  { id: 'SCR-022', name: '좌석맵 에디터', path: routes.eventTab(EVT, 'seatmap'), states: SEATMAP_STATES, note: 'xl 1440 권장' },
  { id: 'SCR-023', name: '상품 빌더 › 상품 목록', path: routes.products(), states: PRODUCT_STATES },
  { id: 'SCR-023', name: '상품 빌더 › 상품 만들기', path: routes.productNew(), states: PRODUCT_STATES },
];
