// 화면 목록(/preview) 등록 C: 부정 거래 조사 화면(SCR-070·071, add-fraud-investigation-screens, ADR-0171). 상태 목록은 각 화면 폴더의 states.ts가 정본이다.
// 디자인 캔버스 보드가 없어 d5 §7.18·§7.19 그림으로 그렸다. 지정 부정 거래 조사관만 연다(?designation=으로 바꿔 본다).
import type { PreviewScreen } from '@peaket/ds/Preview';
import { STATES as CASE_STATES } from '@/pages/investigation-case/states';
import { STATES as LIST_STATES } from '@/pages/investigations/states';

const NOTE = "보드 없음(d5 그림). 기본은 조사관 도윤(cs_lead) 화면. ?role=·?designation=none으로 '권한 없음(지정 없음)'";

export const SCREENS_C: readonly PreviewScreen[] = [
  { id: 'SCR-070', name: '부정 거래 조사 사건 목록', path: '/investigations', states: LIST_STATES, note: NOTE },
  { id: 'SCR-071', name: '사건 작업대', path: '/investigations/CASE-2610-0007', states: CASE_STATES, note: `${NOTE}. 다른 사건(CASE-2610-0005 결정 대기 등)은 사건 목록에서 연다` },
];
