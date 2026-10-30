// 소셜 로그인 수단 목업(캔버스 보드 SCR-004·039·040의 값, d5 §5.4·§5.21·§5.22·§3.5를 옮겼다). 이메일·닉네임은 가린 합성 값이다.
// 공연 이름·매수 한도는 production 조각에 있으므로 여기 두지 않는다(페이지가 합친다, FSD 규칙).

export type ProviderId = 'kakao' | 'naver' | 'google';

/** 화면 글에 쓰는 제공자 이름 */
export const PROVIDER_NAME: Record<ProviderId, string> = { kakao: '카카오', naver: '네이버', google: '구글' };

/** 제공자 가이드 버튼 문구(d5 §5.4, ADR-0062). 한국어 화면 기준 */
export const PROVIDER_LOGIN_LABEL: Record<ProviderId, string> = {
  kakao: '카카오 로그인',
  naver: '네이버 로그인',
  google: 'Google 계정으로 로그인',
};

/** 로그인 화면의 버튼 순서(세 버튼은 같은 크기·같은 비중으로 세로로 쌓는다) */
export const LOGIN_PROVIDERS: readonly ProviderId[] = ['kakao', 'naver', 'google'];

/** 연결된 로그인 수단 한 줄(SCR-040 ①) */
export interface LinkedProvider {
  id: ProviderId;
  /** 처음 연결한 날(KST, YYYY-MM-DD) */
  firstLinked: string;
  /** 최근 로그인(오늘이면 '오늘') */
  lastLogin: string;
}

/** 지민(ME)의 로그인 수단: 카카오로 가입하고 네이버를 더했다 */
export const LINKED_PROVIDERS: readonly LinkedProvider[] = [
  { id: 'kakao', firstLinked: '2026-09-01', lastLogin: '오늘' },
  { id: 'naver', firstLinked: '2026-10-02', lastLogin: '2026-10-02' },
];

/** 같은 이메일 계정 연결 제안(SCR-039, CMP-055). 409 LINK_PROPOSED 응답을 흉내 낸다 */
export const LINK_PROPOSAL = {
  /** 이미 가입한 계정의 로그인 수단 */
  existing: 'kakao' as ProviderId,
  /** 지금 처음 로그인한 수단 */
  incoming: 'google' as ProviderId,
  /** 가린 이메일(전체 이메일·닉네임은 보이지 않는다) */
  maskedEmail: 'j***@g…',
  /** 제안 유효 시간 10분 중 남은 초(보드: 제안 9:41 · 인증 중 9:38 · 다른 계정 7:52) */
  remaining: { proposed: 581, verifying: 578, mismatch: 472 },
  /** 다른 계정으로 인증했을 때 남은 시도(3회가 되면 만료) */
  attemptsLeft: 2,
} as const;

/** 계정 합치기 제안(SCR-040, CMP-056). 흡수 계정은 본인확인 전 계정이라 티켓·후기가 없다(POL-034) */
export const MERGE_PROPOSAL = {
  incoming: 'google' as ProviderId,
  survivor: '본인확인한 계정 · 지민(카카오)',
  absorbed: '구글로 로그인하는 계정',
  /** 옮겨 오는 것 */
  moves: [
    { label: '로그인 수단', value: '1개(구글)' },
    { label: '찜', value: '5개' },
    { label: '알림 신청', value: '2개' },
    { label: '배송지', value: '1곳' },
  ],
  /** 흡수 계정의 주문 수(계정 ID를 고치지 않고 대표 계정 '내 주문'에 함께 보인다) */
  absorbedOrders: 3,
  /** 대표 계정 것을 그대로 쓰는 것 */
  keeps: ['닉네임', '동의 내역'],
  /** 제안 유효 시간 10분 중 남은 초(9:12) */
  remaining: 552,
  /** 병합 불가 예시: 두 계정의 같은 공연 보유 매수 */
  blockedHeld: { mine: 2, absorbed: 3 },
} as const;

/** 합치기 전에 확인하는 다섯 가지(openapi MergeProposal.blockers 코드 순서, d5 §5.22 blocked) */
export type MergeBlockerCode = 'ACTIVE_PURCHASE' | 'QUOTA_EXCEEDED' | 'BOTH_VERIFIED' | 'WITHDRAWAL_OR_APPEAL' | 'ENTRY_STARTED';

export const MERGE_CHECK_TITLES: Record<MergeBlockerCode, string> = {
  ACTIVE_PURCHASE: '진행 중인 홀드·구매 세션·결제 대기',
  QUOTA_EXCEEDED: '합산 한도 초과(공연별 매수·굿즈)',
  BOTH_VERIFIED: '두 계정 모두 본인확인',
  WITHDRAWAL_OR_APPEAL: '흡수될 계정의 탈퇴·이의 제기 처리 중',
  ENTRY_STARTED: '입장 중인 회차의 티켓',
};

/** 세션 종료 사유(asyncapi SessionTerminated, d5 §3.5 표의 팬 문구) */
export type SessionEndReason = 'LOGOUT' | 'ADMIN_FORCE' | 'REFRESH_REUSE' | 'DEVICE_LIMIT' | 'MERGED' | 'DELETE';

export const SESSION_END_TEXT: Record<SessionEndReason, string> = {
  LOGOUT: '다른 기기에서 이 기기를 로그아웃했습니다',
  ADMIN_FORCE: '보안을 위해 운영자가 로그아웃시켰습니다. 다시 로그인해 주세요',
  REFRESH_REUSE: '보안을 위해 모든 기기에서 로그아웃되었습니다. 다시 로그인해 주세요',
  DEVICE_LIMIT: '로그인한 기기가 5대를 넘어 가장 오래 쓰지 않은 이 기기에서 로그아웃했습니다',
  MERGED: '이 계정은 대표 계정으로 합쳐졌습니다. 대표 계정으로 다시 로그인해 주세요',
  DELETE: '탈퇴가 완료되었습니다',
};
