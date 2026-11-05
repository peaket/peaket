// 화면 등록(discovery 쪽: 홈·상세·검색·후기·셔플 검증·고객센터·약관·끼어드는 화면·시스템 안내).
// 상태 목록은 캔버스 보드 data-props의 state 열거값 그대로(첫 값이 기본). 화면 페이지도 이 상수를 가져와 ?state=를 읽는다.
// SCR-001·002는 골격 담당이, 나머지는 discovery 담당이 채웠다. 경로에는 검색 값(?…)을 넣지 않는다(ds previewHref가 ?state=를 그대로 덧붙인다).
import { ORIGINS } from './origins';
import type { WebScreen } from './screens.types';

/**
 * SCR-001 홈: 데이터 단계(HOT-300)에서 목업과 ?state=를 걷어 냈다. 상태(섹션 비어 있음·랭킹 갱신 실패·비로그인 등)는
 * 계약 모양 가짜 API(apps/web/scripts/mock-api.mjs)의 응답으로 본다(ADR-0199 결정 2)
 */
export const SCR001_STATES = ['기본'] as const;
export type Scr001State = (typeof SCR001_STATES)[number];

/**
 * SCR-002 공연 상세: 데이터 단계(HOT-311)에서 목업과 ?state=를 걷어 냈다. 예매 버튼 상태는 시각으로, 판매 중지·후기 없음·비로그인 등은
 * 계약 모양 가짜 API(apps/web/scripts/mock-api.mjs, /__mock/state)의 응답으로 본다(ADR-0199 결정 2, ADR-0200)
 */
export const SCR002_STATES = ['기본'] as const;
export type Scr002State = (typeof SCR002_STATES)[number];

/**
 * SCR-003 검색: 데이터 단계(HOT-312)에서 목업과 ?state=를 걷어 냈다. 결과·빈 결과·바꿔 찾음·필터 빈 결과·관련 공연은 계약 모양 가짜 API
 * (apps/web/scripts/mock-api.mjs)의 검색어(루멘·루맨·fnaps 등)로 본다. 자동완성 창 상태는 HOT-313이 잇는다
 */
export const SCR003_STATES = ['기본'] as const;
export type Scr003State = (typeof SCR003_STATES)[number];

/** SCR-016 후기 모달: 보드 상태 25 + planning/04의 '로딩'(SCR-002 '로딩'과 겹치지 않게 '목록 불러오는 중').
 *  공연 상세(SCR-002)의 ?state=와 이름이 겹치지 않아 같은 ?state=로 고른다 */
export const SCR016_STATES = [
  '전체 모달',
  '사진 보기',
  '신고',
  '신고 · 권리 침해',
  '신고 · 불법 촬영물',
  '신고 입력 오류',
  '신고 확인',
  '신고 보내는 중',
  '신고 전송 실패',
  '신고 한도',
  '신고 대상 없음',
  '신고 접수 완료',
  '신고 로그인 필요',
  '신고기관 바로가기',
  '복사 실패',
  '빈 화면',
  '기능 꺼짐',
  '후기 쓰기(사진)',
  '사진 확인 중',
  '사진 오류',
  '입력 오류',
  '금칙어 오류',
  '이미 씀',
  '자격 없음 대화상자',
  '로그인 필요',
  '목록 불러오는 중',
] as const;
export type Scr016State = (typeof SCR016_STATES)[number];

/** SCR-019 셔플 검증: 보드 상태 6 */
export const SCR019_STATES = ['시드 공개 뒤', '셔플 전', '셔플 직후', '검증 결과 일치', 'FIFO 공연', '파일 없음'] as const;
export type Scr019State = (typeof SCR019_STATES)[number];

/** SCR-056 고객센터·문의: 보드 상태 15를 페이지 넷으로 나눴다(보드 renderVals의 분기대로) */
export const SCR056_HELP_STATES = ['FAQ', '비로그인'] as const;
export type Scr056HelpState = (typeof SCR056_HELP_STATES)[number];
/** 보드 여섯 + '외부 되팔이 게시물 신고'(그 유형을 고른 모양, d5 §5.30 안내, ADR-0173 결정 9. 상태 이름은 추천 적용 2026-10-31) */
export const SCR056_NEW_STATES = ['문의하기', '계좌번호 확인 창', '문의 입력 오류', '접수 중', '접수 실패', '하루 한도', '외부 되팔이 게시물 신고'] as const;
export type Scr056NewState = (typeof SCR056_NEW_STATES)[number];
export const SCR056_LIST_STATES = ['내 문의 내역', '문의 없음'] as const;
export type Scr056ListState = (typeof SCR056_LIST_STATES)[number];
export const SCR056_DETAIL_STATES = ['문의 상세', '접수 완료', '분쟁 문의 상세', '닫힌 문의', '문의를 찾을 수 없음'] as const;
export type Scr056DetailState = (typeof SCR056_DETAIL_STATES)[number];

/** SCR-057 약관·정책: 보드 상태 3(주소의 문서 이름이 있으면 그것을 먼저 따른다) */
export const SCR057_STATES = ['개인정보 처리방침', '이용약관', '없는 문서'] as const;
export type Scr057State = (typeof SCR057_STATES)[number];

/** SCR-058 외부 브라우저 전환 안내: 보드 상태 5 */
export const SCR058_STATES = ['Android', 'iOS 방법 안내', '주소 복사됨', 'Windows', 'Windows 방법 안내'] as const;
export type Scr058State = (typeof SCR058_STATES)[number];

/** SCR-059 시스템 안내: 보드 상태 6 */
export const SCR059_STATES = ['판매 일시 중단', '404', '500', '429', '오프라인', '미지원'] as const;
export type Scr059State = (typeof SCR059_STATES)[number];

export const DISCOVERY_SCREENS: readonly WebScreen[] = [
  { id: 'SCR-001', name: '홈', path: '/', group: 'cached', owner: 'skeleton', states: SCR001_STATES },
  { id: 'SCR-002', name: '공연 상세', path: '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01', group: 'cached', owner: 'skeleton', states: SCR002_STATES },
  { id: 'SCR-003', name: '검색', path: '/search', group: 'cached', owner: 'discovery', states: SCR003_STATES, note: '실제 주소는 /search?q=&page=' },
  {
    id: 'SCR-016',
    name: '후기(전체 모달·쓰기 모달·신고)',
    // 공연 상세가 데이터에 이어져(HOT-311) 가짜 API 고정 자료의 회차로 연다. 상태 고르기(?state=)는 개발 빌드에서만 읽는다
    path: '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01',
    group: 'cached',
    owner: 'discovery',
    states: SCR016_STATES,
    note: '공연 상세 위 모달. 실제 주소는 ?reviews=all · ?review=new · ?report=1234',
  },
  { id: 'SCR-019', name: '셔플 검증', path: '/events/evt-lumen-1025/shuffle-proof', group: 'cached', owner: 'discovery', states: SCR019_STATES },
  { id: 'SCR-056', name: '고객센터(FAQ)', path: '/help', group: 'cached', owner: 'discovery', states: SCR056_HELP_STATES },
  { id: 'SCR-056', name: '문의 목록', path: '/help/inquiries', group: 'request', owner: 'discovery', states: SCR056_LIST_STATES },
  { id: 'SCR-056', name: '문의하기', path: '/help/inquiries/new', group: 'request', owner: 'discovery', states: SCR056_NEW_STATES },
  { id: 'SCR-056', name: '문의 상세', path: '/help/inquiries/inq-0001', group: 'request', owner: 'discovery', states: SCR056_DETAIL_STATES },
  { id: 'SCR-057', name: '약관·정책 문서', path: '/policy/privacy', group: 'cached', owner: 'discovery', states: SCR057_STATES },
  {
    id: 'SCR-058',
    name: '외부 브라우저 전환 안내',
    path: '/open-in-browser',
    group: 'interstitial',
    owner: 'discovery',
    states: SCR058_STATES,
    note: '로비 진입·입장용 휴대폰 등록 직전에 끼어드는 화면. 실제 주소는 /open-in-browser?next=/queue/[eventId]',
  },
  {
    id: 'SCR-059',
    name: '시스템 안내(상태 보기)',
    path: '/system-notice',
    group: 'interstitial',
    owner: 'discovery',
    states: SCR059_STATES,
    note: '개발 서버에서만. 실제로는 묶음별 not-found·error, global-not-found, 판매 일시 중단 정적 파일(/sale-paused.html)',
  },
  { id: 'SCR-059', name: '시스템 안내(없는 주소)', path: '/missing-page-example', group: 'interstitial', owner: 'discovery', states: ['404'], note: '맞는 경로가 없는 주소(global-not-found)' },
  // 대기실 경량 페이지(별도 빌드, 포트 3004). 상태는 대기실 화면 목록에서 고른다
  { id: 'SCR-007', name: '로비(오픈 전)', path: `${ORIGINS.queueRoom}/queue/evt-lumen-1025`, group: 'queue-room', owner: 'queue-room', states: [], external: true },
  { id: 'SCR-008', name: '대기열(오픈 후)', path: `${ORIGINS.queueRoom}/queue/evt-fest-1107`, group: 'queue-room', owner: 'queue-room', states: [], external: true },
  { id: 'SCR-018', name: '매진', path: `${ORIGINS.queueRoom}/queue/evt-musical-1101`, group: 'queue-room', owner: 'queue-room', states: [], external: true },
];
