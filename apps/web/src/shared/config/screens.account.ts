// 화면 등록(account 쪽: 로그인·가입·본인확인·계정·마이·스태프).
// 상태 목록은 캔버스 보드 data-props의 state 열거값 그대로(휴대폰 보드 순서, 태블릿·데스크톱 보드에만 있는 값은 뒤에 붙였다).
// 첫 값이 기본이다. 화면 페이지도 이 상수를 가져와 ?state=를 읽는다. 화면마다 자기 블록만 고친다.
import type { WebScreen } from './screens.types';

// ── SCR-004 로그인 ──
/** 보드 다섯 값 + d5 §3.5 세션 종료 사유 표의 나머지 팬 사유 다섯('세션 종료 안내'는 보드의 원격 로그아웃) */
export const SCR004_STATES = [
  '기본',
  '진행 중',
  '에러',
  '제공자 장애',
  '세션 종료 안내',
  '세션 종료 · 운영자 강제 종료',
  '세션 종료 · 재사용 탐지',
  '세션 종료 · 기기 5대 초과',
  '세션 종료 · 계정 병합',
  '세션 종료 · 탈퇴',
] as const;
export type Scr004State = (typeof SCR004_STATES)[number];

// ── SCR-005 가입 완료·동의 ──
export const SCR005_STATES = ['기본', '닉네임 확인 중', '입력 오류', '만 14세 미만'] as const;
export type Scr005State = (typeof SCR005_STATES)[number];

// ── SCR-006 본인확인 흐름(기관 창·결과 대화상자·복귀 화면) ──
/** 보드 순서 그대로. /verify/return 경로의 기본은 '복귀 화면'(나머지는 부르는 화면 위 창·대화상자를 그린다) */
export const SCR006_STATES = [
  '기관 응답 대기',
  '창을 닫음·실패',
  '기관 장애',
  '다른 계정의 본인',
  '재확인 목적',
  '부스 대조 목적',
  '부스 대조 불일치',
  '만 14세 미만',
  '완료 토스트',
  '팝업 차단',
  '부스 대조 동의 없음',
  '복귀 화면',
] as const;
export type Scr006State = (typeof SCR006_STATES)[number];

// ── SCR-017 계정 설정 ──
export const SCR017_STATES = [
  '기본',
  '원격 로그아웃 재인증',
  '재인증 실패',
  '원격 로그아웃 완료',
  '탈퇴 확인',
  '탈퇴 확인 · 가상계좌 지금 환급',
  '탈퇴 확인 · 가상계좌 나중 환급',
  '탈퇴 완료',
  '탈퇴 접수(미룸)',
  '탈퇴 접수 · 결제 확정 대기',
  '로그아웃 확인',
  '예매 제한 중',
  /** d5 §5.17 상태 표에서 더함(보드에 없음) */
  '기기 목록 로딩',
  /** d5 §5.17 탈퇴 단계의 대조값 보관 안내 두 줄(탈퇴 409 fraudHold, ADR-0173 결정 7). 상태 이름은 추천 적용 2026-10-31 */
  '탈퇴 확인 · 부정 예매 이용 제한 중',
  '탈퇴 확인 · 부정 예매 소명 요청 받음',
  /** d5 §5.17 ①의 '또는 [ 지금 본인확인 ]'(보드와 목업 ME는 본인확인 완료라 그 갈래를 볼 상태가 없었다, 2026-11-05 BOT-020이 넘긴 것) */
  '본인확인 전',
] as const;
export type Scr017State = (typeof SCR017_STATES)[number];

// ── SCR-039 계정 연결 제안 ──
export const SCR039_STATES = ['제안', '카카오 인증 중', '다른 계정으로 인증', '연결 성공', '만료'] as const;
export type Scr039State = (typeof SCR039_STATES)[number];

// ── SCR-040 로그인 수단·병합 ──
/** 보드 값(휴대폰 여섯 + 데스크톱 '병합 확인') + d5 §5.22 상태 표의 loading('요약 계산 중') */
export const SCR040_STATES = ['목록', '병합 요약', '병합 확인', '병합 불가', '병합 중', '제안 만료', '흡수된 세션 안내', '요약 계산 중'] as const;
export type Scr040State = (typeof SCR040_STATES)[number];

// ── SCR-042 소명 제출 ──
export const SCR042_STATES = [
  '작성',
  '양도 회수 사유',
  '제출됨',
  '기한 지남',
  '결과 · 제한 해제',
  '결과 · 제한 유지',
  '결과 · 회수하지 않음',
  '결과 · 회수됨',
  '빈 화면',
  '소명 닫힘(대상 아님·기한 경과)',
  /** 보드에 없고 d5 §5.24 submitted 줄에 있는 양도 회수 소명의 처리 일정('입장이 시작되기 전에') */
  '제출됨 · 양도 회수',
  /** 보드에 없고 d5 §5.24 '부정 예매 소명' 상태 표에서 더했다(apl-0003, add-fraud-investigation-screens 결정 9) */
  '부정 예매 소명',
  '제출됨 · 부정 예매',
  '결과 · 부정 예매 소명 인정',
  '결과 · 부정 예매 소명 불인정',
  /** d5 §5.24 상태 표에서 더했다(apply-legal-review-to-screens, ADR-0173). '이의 결과 · 부정 예매'는 배지 둘(인정·기각)로 나눴다(추천 적용 2026-10-31) */
  '양도 잠금 풀림 · 부정 예매',
  '조치 결과 · 부정 예매',
  '이의 결과 · 부정 예매 · 인정',
  '이의 결과 · 부정 예매 · 기각',
  /** d5 §5.24 '받은 사람의 변형' 상태 표(party HOLDER, apl-0004, ADR-0173 결정 4) */
  '받은 표 확인 요청',
  '제출됨 · 받은 표',
  '결과 · 취소 대상에서 빠짐',
  '결과 · 취소됨',
] as const;
export type Scr042State = (typeof SCR042_STATES)[number];
/** 부정 예매 소명 결제자(apl-0003) 미리 보기 목록에 올리는 상태 */
export const SCR042_FRAUD_STATES = [
  '부정 예매 소명',
  '제출됨 · 부정 예매',
  '결과 · 부정 예매 소명 인정',
  '결과 · 부정 예매 소명 불인정',
  '양도 잠금 풀림 · 부정 예매',
  '조치 결과 · 부정 예매',
  '이의 결과 · 부정 예매 · 인정',
  '이의 결과 · 부정 예매 · 기각',
] as const satisfies readonly Scr042State[];
/** 부정 예매 소명 받은 사람(apl-0004) 미리 보기 목록에 올리는 상태 */
export const SCR042_HOLDER_STATES = ['받은 표 확인 요청', '제출됨 · 받은 표', '결과 · 취소 대상에서 빠짐', '결과 · 취소됨'] as const satisfies readonly Scr042State[];

// ── SCR-043 배상금 계좌 입력 ──
export const SCR043_STATES = ['입력', '재인증 시트', '재인증 만료', '송금 요청 중', '계좌 오류', '3회 실패', '이미 지급', '완료'] as const;
export type Scr043State = (typeof SCR043_STATES)[number];

// ── SCR-050 현장 스태프 초대 수락 ──
export const SCR050_STATES = [
  '동의 전',
  '동의 완료',
  '이메일 불일치',
  '본인확인 필요',
  '만료',
  '이미 배정',
  '검증 이메일 없음',
  '동의 누락',
  '수락 완료',
  '조회 중',
] as const;
export type Scr050State = (typeof SCR050_STATES)[number];

// ── SCR-051 스캐너 승인(휴대폰 쪽) ──
export const SCR051_STATES = [
  '승인 대기',
  '로그인 필요',
  '조회 중',
  '배정 고르기',
  '대리 승인',
  '승인됨',
  '거부함',
  '코드 만료',
  '시도 초과',
  '권한 없음 · 배정 없음',
  '권한 없음 · 다른 파트너 기기',
  '권한 없음 · 운영 시간 밖',
  '권한 없음 · 대리 승인',
  '파트너 이름을 읽지 못함',
] as const;
export type Scr051State = (typeof SCR051_STATES)[number];

// ── SCR-054 관심 공연·알림 신청 ──
export const SCR054_STATES = ['관심 공연', '알림 신청 탭', '오프라인 저장 대기', '빈 화면', '알림 신청 빈 화면', '신청 끝 · 끝난 까닭 셋'] as const;
export type Scr054State = (typeof SCR054_STATES)[number];

// ── SCR-055 예매·주문 내역(목록 /my/orders · 상세 /my/orders/[orderId]) ──
/** 목록 경로의 상태(보드 순서. '로딩'은 보드에 없어 d5 §5.29 상태 표에서 더했다) */
export const SCR055_STATES = ['목록', '빈 화면', '굿즈 탭', '로딩'] as const;
export type Scr055State = (typeof SCR055_STATES)[number];
/** 상세 경로의 상태. 휴대폰 보드 '주문 상세'와 데스크톱 보드 '예매 확인서'는 같은 예매 확인서(2026101400123)라 '주문 상세' 하나로 둔다.
 *  굿즈·부가 상품 주문 id를 열면 기본은 '굿즈 주문 상세' */
export const SCR055_DETAIL_STATES = ['주문 상세', '굿즈 주문 상세', '굿즈 주문 취소 확인', '반품 요청', '입금 오류'] as const;
export type Scr055DetailState = (typeof SCR055_DETAIL_STATES)[number];

// ── SCR-060 환불 계좌 입력(지연 환급) ──
export const SCR060_STATES = ['입력', '재인증 시트', '재인증 만료', '제출 중', '계좌 오류', '완료'] as const;
export type Scr060State = (typeof SCR060_STATES)[number];

// ── SCR-061 내 현장 배정 ──
export const SCR061_STATES = ['기본', '곧 시작', '해제됨', '빈 화면', '조회 중'] as const;
export type Scr061State = (typeof SCR061_STATES)[number];

export const ACCOUNT_SCREENS: readonly WebScreen[] = [
  {
    id: 'SCR-004',
    name: '로그인',
    path: '/login',
    group: 'request',
    owner: 'account',
    states: SCR004_STATES,
    note: '세션 종료 사유 다섯은 d5 §3.5 표에서 더했다(보드는 원격 로그아웃 하나)',
  },
  { id: 'SCR-005', name: '가입 완료·동의', path: '/signup/consent', group: 'request', owner: 'account', states: SCR005_STATES },
  {
    id: 'SCR-006',
    name: '본인확인 흐름(복귀 화면)',
    path: '/verify/return',
    group: 'cached',
    owner: 'account',
    states: SCR006_STATES,
    note: '기관 창·결과 대화상자는 부르는 화면(공연 상세 등) 위. 이 경로의 기본 상태는 복귀 화면',
  },
  {
    id: 'SCR-017',
    name: '계정 설정',
    path: '/my/settings',
    group: 'request',
    owner: 'account',
    states: SCR017_STATES,
    note: '로그아웃 확인은 셸의 대화상자. 기기 목록 로딩, 탈퇴 확인의 부정 예매 대조값 보관 안내 둘(ADR-0173), 본인확인 전(d5 ①)은 d5에서 더함',
  },
  { id: 'SCR-039', name: '계정 연결 제안', path: '/login/link', group: 'request', owner: 'account', states: SCR039_STATES },
  {
    id: 'SCR-040',
    name: '로그인 수단·병합',
    path: '/my/settings/providers',
    group: 'request',
    owner: 'account',
    states: SCR040_STATES,
    note: "'병합 확인'은 휴대폰에서 시트. '요약 계산 중'은 d5 상태 표(loading)에서 더했다",
  },
  {
    id: 'SCR-042',
    name: '소명 제출',
    path: '/my/appeals/apl-0001',
    group: 'request',
    owner: 'account',
    states: SCR042_STATES.filter((st) => !([...SCR042_FRAUD_STATES, ...SCR042_HOLDER_STATES] as readonly string[]).includes(st)),
    note: "예매 제한(apl-0001)과 양도 회수(apl-0002) 두 건을 한 경로의 상태로 본다. '제출됨 · 양도 회수'는 d5에서 더했다. 부정 예매 소명 상태는 아래 apl-0003 줄",
  },
  {
    id: 'SCR-042',
    name: '소명 제출(부정 예매 소명)',
    path: '/my/appeals/apl-0003',
    group: 'request',
    owner: 'account',
    states: SCR042_FRAUD_STATES,
    note: "부정 예매 소명 요청 건(apl-0003, 보드 없음 → d5 §5.24 그림). 기한이 지난 뒤와 소명 닫힘은 위 줄의 '기한 지남'·'소명 닫힘'과 같은 화면이다. 잠금 풀림·조치 결과·이의 결과는 ADR-0173(2026-10-31)",
  },
  {
    id: 'SCR-042',
    name: '소명 제출(부정 예매 · 받은 사람)',
    path: '/my/appeals/apl-0004',
    group: 'request',
    owner: 'account',
    states: SCR042_HOLDER_STATES,
    note: '사건 계정이 결제한 표를 양도로 받아 가진 분(party HOLDER, apl-0004, d5 §5.24 받은 사람의 변형, ADR-0173 결정 4). 사유 범주·이의는 없다',
  },
  { id: 'SCR-043', name: '배상금 계좌 입력', path: '/my/compensations/cmp-0001', group: 'request', owner: 'account', states: SCR043_STATES },
  {
    id: 'SCR-050',
    name: '현장 스태프 초대 수락',
    path: '/staff/invitations',
    group: 'cached',
    owner: 'account',
    states: SCR050_STATES,
    note: '실제 주소는 /staff/invitations#token=(조각은 읽고 지운다). 두 동의를 체크하면 수락이 켜지고 수락 완료 상태로 간다',
  },
  {
    id: 'SCR-051',
    name: '스캐너 승인(휴대폰 쪽)',
    path: '/staff/approve',
    group: 'cached',
    owner: 'account',
    states: SCR051_STATES,
    note: '실제 주소는 /staff/approve#code=. 대리 승인 칸·배정 고르기를 눌러 볼 수 있고, 승인·거부는 같은 경로의 상태로 간다',
  },
  {
    id: 'SCR-054',
    name: '관심 공연·알림 신청',
    path: '/my/likes',
    group: 'request',
    owner: 'account',
    states: SCR054_STATES,
    note: '?tab=alerts로 들어오면 알림 신청 탭(계정 설정의 신청 목록 링크)',
  },
  {
    id: 'SCR-055',
    name: '예매·주문 내역',
    path: '/my/orders',
    group: 'request',
    owner: 'account',
    states: SCR055_STATES,
    note: '데스크톱은 표 + 오른쪽 안내 패널(줄을 고르면 상세 경로로 간다)',
  },
  {
    id: 'SCR-055',
    name: '예매·주문 상세',
    path: '/my/orders/ord-20261014-0001',
    group: 'request',
    owner: 'account',
    states: SCR055_DETAIL_STATES,
    note: '데스크톱은 왼쪽 표 + 오른쪽 상세 패널. 굿즈 주문은 /my/orders/ord-20261018-0010(기본 굿즈 주문 상세)',
  },
  { id: 'SCR-060', name: '환불 계좌 입력(지연 환급)', path: '/my/refunds/rfd-0001/account', group: 'request', owner: 'account', states: SCR060_STATES },
  {
    id: 'SCR-061',
    name: '내 현장 배정',
    path: '/staff',
    group: 'request',
    owner: 'account',
    states: SCR061_STATES,
    note: "셸 메뉴 '현장 근무'와 초대 수락 뒤에 온다. 안내 줄의 '스캐너 화면'은 스캐너 앱 로그인(3003)으로 잇는다",
  },
];
