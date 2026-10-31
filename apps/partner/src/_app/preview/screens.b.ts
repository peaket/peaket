// 화면 목록(/preview) 등록 파일 B: 다음 파트너 담당 화면(SCR-024·025·026·027·037·044·059). 상태 목록은 shared/config/states/의 상수를 그대로 쓴다.
import type { PreviewScreen } from '@peaket/ds/Preview';
import { PRIMARY_PRODUCTION_ID } from '@/entities/production';
import { routes } from '@/shared/config/routes';
import { POLICY_STATES } from '@/shared/config/states/scr024';
import { WEBHOOK_STATES } from '@/shared/config/states/scr025';
import { LIVE_STATES } from '@/shared/config/states/scr026';
import { SETTLEMENT_STATES } from '@/shared/config/states/scr027';
import { STAFF_STATES } from '@/shared/config/states/scr037';
import { CANCELLATION_STATES } from '@/shared/config/states/scr044';
import { NOTICE_STATES } from '@/shared/config/states/scr059';

const EVT = PRIMARY_PRODUCTION_ID;

export const screensB: readonly PreviewScreen[] = [
  { id: 'SCR-024', name: '판매 정책 규칙(DSL)', path: routes.eventTab(EVT, 'policy'), states: POLICY_STATES, note: '휴대폰은 보기 전용' },
  { id: 'SCR-025', name: '웹훅 연동', path: routes.settingsWebhooks(), states: WEBHOOK_STATES, note: '?role=member로 실무자 보기' },
  { id: 'SCR-026', name: '실시간 판매 현황', path: routes.eventTab(EVT, 'live'), states: LIVE_STATES, note: '?round=<회차 id>|all · xl 1440 6칸' },
  {
    id: 'SCR-027',
    name: '정산 리포트·명단',
    path: routes.eventTab(EVT, 'settlement'),
    states: SETTLEMENT_STATES,
    note: '상태가 하위 탭(정산서·판매 요약·예매자 명단·다운로드 이력·부정 예매 조치)도 고른다',
  },
  { id: 'SCR-037', name: '현장 스태프·현장 운영', path: routes.eventTab(EVT, 'staff'), states: STAFF_STATES, note: '상태가 하위 탭(스태프·현장 운영)도 고른다' },
  { id: 'SCR-044', name: '회차 취소·연기 요청', path: routes.eventTab(EVT, 'cancellation'), states: CANCELLATION_STATES },
  { id: 'SCR-059', name: '시스템 안내(파트너)', path: '/system-notice-preview', states: NOTICE_STATES, note: '일부러 없는 주소 — 404 화면에서 ?state=로 고른다' },
];
