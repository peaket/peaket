// 공연 상세의 사전 검증 토큰 저장과 행동 신호 요약(SCR-002 ⑦, docs/frontend.md §3.1·§3.12·§4.2.1 3번, ADR-0211 결정 3·4).
// 첫 화면 묶음에 드는 가벼운 부분만 둔다. 응답 읽기·오류 판단·흐름은 늦게 싣는 flow.ts에 있다.
// 토큰은 대기실과 같은 회차 키 `peaket.queue.{eventId}`에 둔다(대기실이 그 값으로 진입한다, ADR-0207). 그 키의 다른 값은 건드리지 않는다.
// 행동 신호 요약(openapi BehaviorSummary v1)은 수·엔트로피·간격만 잰다. 좌표·키 값·입력한 글자는 남기지 않는다(ADR-0065 결정 9).

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface Preverify {
  token: string;
  /** 이 토큰을 받은 시각(밀리초, 보정 시계) */
  issuedAt: number;
  /** 만료 시각(응답의 expiresAt) */
  expiresAt: number;
}

/** 사전 검증 토큰 수명(15분, ADR-0041). 대기실이 만료 칸 없이 다시 썼을 때만 쓴다 */
const TTL_MS = 15 * 60_000;
/** 만료 2분 [가정] 전부터 조용히 갱신한다(§3.1) */
export const REFRESH_BEFORE_MS = 120_000;
/** 진입에 쓰려면 이만큼 [가정]은 남아야 한다(대기실이 진입을 보내기 전에 끝나지 않게) */
export const MIN_LEFT_MS = 30_000;

const keyOf = (eventId: string) => `peaket.queue.${eventId}`;
const nat = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function readPreverify(kv: KV | null, eventId: string, now: number): Preverify | null {
  try {
    const r = JSON.parse(kv?.getItem(keyOf(eventId)) ?? 'null') as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || typeof r.preverifyToken !== 'string' || r.preverifyToken.length === 0 || r.preverifyToken.length > 4096) return null;
    const issuedAt = nat(r.preverifyIssuedAt) ? r.preverifyIssuedAt : null;
    const expiresAt = nat(r.preverifyExpiresAt) ? r.preverifyExpiresAt : issuedAt !== null ? issuedAt + TTL_MS : null;
    if (expiresAt === null || expiresAt <= now) return null;
    return { token: r.preverifyToken, issuedAt: issuedAt ?? expiresAt - TTL_MS, expiresAt };
  } catch {
    return null;
  }
}

/** 회차 키에 토큰을 쓴다(다른 칸은 그대로). 저장소를 못 쓰면 false */
export function writePreverify(kv: KV | null, eventId: string, p: Preverify, now: number): boolean {
  if (!kv) return false;
  let r: Record<string, unknown> = {};
  try {
    const v = JSON.parse(kv.getItem(keyOf(eventId)) ?? 'null') as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) r = v as Record<string, unknown>;
  } catch {
    r = {};
  }
  // 대기실 저장소는 시각 칸을 정수로만 받는다(보정 시계는 소수일 수 있다)
  r.preverifyToken = p.token;
  r.preverifyIssuedAt = Math.round(p.issuedAt);
  r.preverifyExpiresAt = Math.round(p.expiresAt);
  r.savedAt = Math.round(now);
  try {
    kv.setItem(keyOf(eventId), JSON.stringify(r));
    return true;
  } catch {
    return false;
  }
}

export const needsRefresh = (p: Preverify, now: number): boolean => p.expiresAt - now <= REFRESH_BEFORE_MS;
export const usableForEntry = (p: Preverify | null, now: number): boolean => p !== null && p.expiresAt - now > MIN_LEFT_MS;

// 행동 신호 요약은 공연 상세·좌석 화면이 함께 쓴다(features/behavior-summary).
export { createBehaviorTracker, type BehaviorSummary } from '../behavior-summary/tracker.ts';
