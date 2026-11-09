// 내 예매 제한(GET /v1/booking-restrictions/me, ADR-0213 결정 2·3). 순수 함수만 둔다(node --test가 바로 불러 본다).
// 이 값은 화면용 사본이라 늦을 수 있고, 집행은 입장 확정 403 booking-restricted가 한다(queue-admission §6).
import { kstParts, parseTime } from '../../shared/lib/kst.ts';

export interface BookingRestrictionLike {
  status?: string;
  restrictionId?: string | null;
  reasonCode?: string | null;
  endsAt?: string | null;
  appealDueAt?: string | null;
}

export type Restriction =
  | { status: 'none' }
  | { status: 'active'; restrictionId: string | null; reasonCode: string | null; appealDueAtMs?: number; endsAtMs?: number };

/** 받기 전(idle)·받는 중(loading)까지 더한 상태 */
export type RestrictionState = { status: 'idle' } | { status: 'loading' } | Restriction;

/** ACTIVE만 제한이다(LIFTED·EXPIRED는 서버가 NONE으로 보인다, 모르는 값도 제한 없음) */
export function toRestriction(s: BookingRestrictionLike): Restriction {
  if (s.status !== 'ACTIVE') return { status: 'none' };
  const appealDueAtMs = parseTime(s.appealDueAt);
  const endsAtMs = parseTime(s.endsAt);
  return {
    status: 'active',
    restrictionId: s.restrictionId ?? null,
    reasonCode: s.reasonCode ?? null,
    ...(appealDueAtMs !== undefined ? { appealDueAtMs } : {}),
    ...(endsAtMs !== undefined ? { endsAtMs } : {}),
  };
}

const md = (ms: number): string => {
  const k = kstParts(ms);
  return `${k.m}/${k.d}`;
};

/**
 * 공연 상세 ⑦의 글과 ( 소명하기 › )(d5 §5.2 '예매 제한 중'). 소명 기한 전이고 제한 ID가 있으면 링크를 단다.
 * 기한이 지났으면 링크 없이 끝 날짜(정해졌으면)를 붙인다. 제한이 아니면 null
 */
export function restrictionCta(r: RestrictionState, nowMs: number, appealHref: (restrictionId: string) => string): { text: string; appealHref?: string } | null {
  if (!inForce(r, nowMs)) return null;
  const base = '예매가 제한되어 있습니다';
  const open = r.appealDueAtMs === undefined || r.appealDueAtMs > nowMs;
  if (open) {
    const text = r.appealDueAtMs !== undefined ? `${base} · 소명 기한 ${md(r.appealDueAtMs)}` : base;
    return r.restrictionId ? { text, appealHref: appealHref(r.restrictionId) } : { text };
  }
  return { text: r.endsAtMs !== undefined ? `${base} · ${md(r.endsAtMs)}까지` : base };
}

/** 예매 제한이 ⑦을 덮는 때(ADR-0213 결정 2): 판매 종료·취소 회차가 아니고 아직 살 수 있는 때 */
const RESTRICTABLE = new Set(['closed', 'pending', 'notYet', 'lobby', 'fifo', 'queue']);
/** 제한을 받는 동안 뼈대로 두는 때: 지금 들어갈 수 있거나 곧 들어갈 수 있는 때(personalCta가 뼈대를 두는 때와 같다) */
const ENTERABLE = new Set(['notYet', 'lobby', 'queue']);

/** 지금 걸려 있는 제한인가: 끝 시각이 지났으면 풀린 것으로 본다(사본이 늦어도 오픈 시각에 다시 고를 때 버튼이 돌아오게) */
function inForce(r: RestrictionState, nowMs: number): r is Extract<Restriction, { status: 'active' }> {
  return r.status === 'active' && (r.endsAtMs === undefined || r.endsAtMs > nowMs);
}

/**
 * 공연 상세 ⑦을 예매 제한으로 덮을지. 회원 팬만 본다(비로그인·모름·세션 받는 중은 로그인 버튼·뼈대가 먼저다).
 * restricted: 제한 글과 ( 소명하기 › ) · loading: 제한을 받는 중(뼈대, 들어갈 수 있는 때만) · null: 덮지 않는다(가입·본인확인·시각 상태로).
 * 로비 열리기 전·선착순 오픈 전은 받는 동안 지금 버튼을 두고, 답이 오면 바꾼다(버튼이 뼈대로 깜빡이지 않게)
 */
export function restrictionGate(phase: string | undefined, s: { status: string }, r: RestrictionState, nowMs: number): 'restricted' | 'loading' | null {
  if (s.status !== 'member' || !phase || !RESTRICTABLE.has(phase)) return null;
  if (r.status === 'idle' || r.status === 'loading') return ENTERABLE.has(phase) ? 'loading' : null;
  return inForce(r, nowMs) ? 'restricted' : null;
}
