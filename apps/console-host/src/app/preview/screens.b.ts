// 화면 목록(/preview) 등록 B: 관제 다음 퍼블리싱 차례의 화면(SCR-045~049·053·064~068·059 관제 변형). 상태 목록은 각 화면 폴더의 states.ts가 정본이다.
// 형식: PreviewScreen { id: 'SCR-0NN', name, path(목업 ID를 채운 실제 경로), states(첫 값이 기본), note? }
import type { PreviewScreen } from '@peaket/ds/Preview';
import { STATES as ACCOUNTS } from '@/pages/accounts/states';
import { STATES as BOT_REVIEW } from '@/pages/bot-review/states';
import { STATES as CANCELLATION } from '@/pages/cancellation/states';
import { STATES as CS_APPROVALS } from '@/pages/cs-approvals/states';
import { STATES as CS_INBOX } from '@/pages/cs-inbox/states';
import { STATES as CUSTOMERS } from '@/pages/customers/states';
import { STATES as NOTICES } from '@/pages/notices/states';
import { STATES as PARTNERS } from '@/pages/partners/states';
import { STATES as SALE_REVIEW } from '@/pages/sale-review/states';
import { STATES as SCANNER_DEVICES } from '@/pages/scanner-devices/states';
import { STATES as SETTLEMENTS } from '@/pages/settlements/states';
import { STATES as SYSTEM } from '@/pages/system/states';

const ROLE_NOTE = '?role=로 역할을 바꾸면 그 역할의 버튼 비활성·숨김(d5 §3.3)';

export const SCREENS_B: readonly PreviewScreen[] = [
  { id: 'SCR-045', name: 'CS 처리함', path: '/cs/inbox', states: CS_INBOX, note: `보드는 cs_agent 다은의 화면. ${ROLE_NOTE}` },
  { id: 'SCR-046', name: '승인 업무', path: '/cs/approvals', states: CS_APPROVALS, note: `보드는 cs_lead 준의 화면. ${ROLE_NOTE}` },
  {
    id: 'SCR-047',
    name: '회차 취소 판정·일괄 환불',
    path: '/cancellations/cr-lumen-r1',
    states: CANCELLATION,
    note: `휴대폰 기본 상태는 '제2 승인 대기'(민호). ${ROLE_NOTE}`,
  },
  { id: 'SCR-048', name: '판매 승인', path: '/sale-reviews/prd-lumen-2026', states: SALE_REVIEW, note: ROLE_NOTE },
  { id: 'SCR-049', name: '정산 지급', path: '/settlements', states: SETTLEMENTS, note: `?role=viewer는 'viewer 보기', CS 역할은 'CS 담당자'로 연다` },
  { id: 'SCR-053', name: '스캐너 기기 관리', path: '/scanner-devices', states: SCANNER_DEVICES, note: ROLE_NOTE },
  { id: 'SCR-064', name: '관리 계정·세션 관리', path: '/accounts', states: ACCOUNTS, note: `?role=operator는 '파트너 계정 탭'으로 연다` },
  { id: 'SCR-065', name: '파트너사·계약 관리', path: '/partners', states: PARTNERS, note: ROLE_NOTE },
  { id: 'SCR-066', name: '팬 조회', path: '/customers', states: CUSTOMERS, note: '보드는 cs_agent 다은의 화면' },
  { id: 'SCR-067', name: '봇 판정 표본 검토', path: '/bot-review', states: BOT_REVIEW, note: 'CS 두 역할만 연다(다른 역할은 권한 안내)' },
  { id: 'SCR-068', name: '공지 관리', path: '/notices', states: NOTICES, note: `홈 구성 포함. ?role=viewer는 홈 구성 읽기` },
  {
    id: 'SCR-059',
    name: '시스템 안내(관제 변형 · 없는 주소)',
    path: '/not-found-example',
    states: SYSTEM,
    note: '관제 셸 안에 그린다. 없는 주소라 처음 값은 404',
  },
];
