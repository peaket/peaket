// 다시 시도 기다림과 재시도 예산(docs/frontend.md §4.1 '기다림'·§5.9, docs/api/guidelines.md §5).
// 서버가 준 다시 시도 시각(Retry-After 초·HTTP 날짜, 본문 retryAfterSeconds·pollHintMs)은 하한이고, 기다림 = 하한 × (1 + U(0, 0.2))로
// 위쪽으로만 퍼뜨린다. NOT_YET의 retryAfterMs는 사람마다 계산한 예상 도래 시각이라 지터 없이 그 시각을 쓴다.
// 하한이 없으면 전체 지터(0부터 지금 상한 사이의 고른 무작위 값)이고 상한은 0.5초에서 두 배씩 8초까지다 [가정].

export type Random = () => number;

const FULL_JITTER_START_MS = 500;
const FULL_JITTER_CAP_MS = 8000;
const UPWARD_JITTER = 0.2;

/** Retry-After 헤더 → 기다릴 ms(지금 기준). 읽지 못하면 undefined */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | undefined {
  if (header == null) return undefined;
  const v = header.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** 하한이 없을 때: attempt번째 다시 시도(0부터)의 전체 지터 */
export function fullJitterMs(attempt: number, random: Random): number {
  const cap = Math.min(FULL_JITTER_CAP_MS, FULL_JITTER_START_MS * 2 ** attempt);
  return cap * random();
}

export interface RetryHint {
  retryAfterHeader?: string | null;
  body?: { retryAfterSeconds?: number; pollHintMs?: number; retryAfterMs?: number } | null;
  attempt: number;
  random: Random;
  nowMs: number;
}

/** 다음 다시 시도까지 기다릴 ms */
export function retryDelayMs(h: RetryHint): number {
  const exact = h.body?.retryAfterMs;
  if (typeof exact === 'number' && Number.isFinite(exact) && exact >= 0) return exact;
  const floors = [
    parseRetryAfter(h.retryAfterHeader, h.nowMs),
    typeof h.body?.retryAfterSeconds === 'number' ? h.body.retryAfterSeconds * 1000 : undefined,
    typeof h.body?.pollHintMs === 'number' ? h.body.pollHintMs : undefined,
  ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (floors.length === 0) return fullJitterMs(h.attempt, h.random);
  const floor = Math.max(...floors);
  return floor * (1 + UPWARD_JITTER * h.random());
}

/** 한 페이지의 자동 재시도 예산: 분당 60회(guidelines §5) */
export class RetryBudget {
  private readonly stamps: number[] = [];
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly perMinute = 60,
  ) {}

  /** 쓸 수 있으면 한 번 쓰고 true */
  take(): boolean {
    const t = this.now();
    while (this.stamps.length > 0 && t - this.stamps[0]! >= 60_000) this.stamps.shift();
    if (this.stamps.length >= this.perMinute) return false;
    this.stamps.push(t);
    return true;
  }
}
