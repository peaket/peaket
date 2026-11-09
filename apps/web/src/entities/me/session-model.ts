// 팬 계정 요약(GET /v1/identity/me, FanAccountSummary) → 화면 값(ADR-0202 결정 1·2·3). 순수 함수라 node --test가 바로 돌린다.
// 화면 스크립트가 페이지마다 한 번 받는 값이다(session.ts). 셸 머리와 공연 상세 예매 버튼이 같은 값을 쓴다.

/** 계약 FanAccountSummary 모양(api-client 생성 형식과 같다) */
export interface FanAccountSummaryLike {
  nickname?: string | null;
  signupCompleted?: boolean;
  verified?: boolean;
  hasStaffAssignment?: boolean;
}

export interface FanMember {
  /** 표시 이름(닉네임, 가입을 마치기 전이면 '회원') */
  name: string;
  avatarText: string;
  verified: boolean;
  signupCompleted: boolean;
  hasStaffAssignment: boolean;
}

/**
 * loading: 받기 전 · guest: 401(갱신 뒤에도) 또는 API 출처가 없는 실행 · unknown: 5xx·연결 실패로 모름 · member: 로그인한 팬
 */
export type FanSession = { status: 'loading' } | { status: 'guest' } | { status: 'unknown' } | { status: 'member'; me: FanMember };

const PENDING_NAME = '회원';

const firstGrapheme = (s: string): string => {
  const seg = new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next();
  return seg.done ? '' : seg.value.segment;
};

export function toMember(s: FanAccountSummaryLike): FanMember {
  const name = s.nickname ? s.nickname : PENDING_NAME;
  return {
    name,
    avatarText: firstGrapheme(name),
    verified: s.verified === true,
    signupCompleted: s.signupCompleted === true,
    hasStaffAssignment: s.hasStaffAssignment === true,
  };
}

/** 셸 머리 사용자: undefined는 받기 전(계정 자리를 빈자리로), null은 [로그인] */
export function shellUserOf(s: FanSession): { name: string; avatarText: string; verified: boolean; hasStaffAssignment: boolean } | null | undefined {
  if (s.status === 'loading') return undefined;
  if (s.status !== 'member') return null;
  const { name, avatarText, verified, hasStaffAssignment } = s.me;
  return { name, avatarText, verified, hasStaffAssignment };
}

/** 개인 상태로 덮는 예매 단계: 로비 버튼 차례 기다림·로비 열림·오픈 뒤 진입(ADR-0202 결정 3) */
const ENTERABLE = new Set(['notYet', 'lobby', 'queue']);

/**
 * 공연 상세 ⑦ 버튼을 개인 상태로 덮을지(d5 §5.2 '비로그인'·'본인확인 필요').
 * login: [[ 로그인하고 입장 ]] · verify: [[ 휴대폰 본인확인 ]] · signup: [[ 가입을 마치고 입장 ]] [가정] · loading: 받기 전(뼈대) · null: 덮지 않는다.
 * 모를 때(unknown)는 덮지 않는다. 진입 경로가 로그인·본인확인을 다시 확인해 막는다(로비·대기열 401·403)
 */
export function personalCta(phase: string | undefined, s: FanSession): 'login' | 'verify' | 'signup' | 'loading' | null {
  if (!phase || !ENTERABLE.has(phase)) return null;
  if (s.status === 'loading') return 'loading';
  if (s.status === 'guest') return 'login';
  if (s.status !== 'member') return null;
  if (!s.me.signupCompleted) return 'signup';
  return s.me.verified ? null : 'verify';
}
