// 화면 목록(/preview) 등록 A: 관제 첫 퍼블리싱 차례의 화면(SCR-028~032). 상태 목록은 각 화면 폴더의 states.ts가 정본이다.
// 형식: PreviewScreen { id: 'SCR-0NN', name, path(목업 ID를 채운 실제 경로), states(첫 값이 기본), note? }
import type { PreviewScreen } from '@peaket/ds/Preview';
import { STATES as AUDIT } from '@/pages/audit/states';
import { STATES as COMMANDS } from '@/pages/commands/states';
import { STATES as COMPLIANCE } from '@/pages/compliance/states';
import { STATES as DASHBOARD } from '@/pages/dashboard/states';
import { LOGIN_STATES, ME_STATES } from '@/pages/login/states';

export const SCREENS_A: readonly PreviewScreen[] = [
  { id: 'SCR-028', name: '운영자 로그인', path: '/login', states: LOGIN_STATES },
  { id: 'SCR-028', name: '내 계정', path: '/me', states: ME_STATES, note: "화면 테마·한 글자 단축키 스위치. '내 계정'은 보안 설정 재인증 대화상자가 열린 상태" },
  { id: 'SCR-029', name: '중앙 관제 대시보드', path: '/dashboard', states: DASHBOARD, note: '?role=viewer|operator|commander|cs_agent|cs_lead로 역할을 바꿔 본다' },
  { id: 'SCR-030', name: '운영 명령', path: '/commands', states: COMMANDS, note: '휴대폰 기본 상태는 두 번째 승인(민호)' },
  { id: 'SCR-031', name: '감사 로그·인시던트 리플레이', path: '/audit', states: AUDIT },
  { id: 'SCR-032', name: '법정 조치', path: '/compliance', states: COMPLIANCE },
];
