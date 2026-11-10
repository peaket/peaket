// 낮춘 결제사 채널 상한의 표 행과 규칙(docs/features/payment.md §2 '낮춘 상한의 유지·전파·회복', docs/data.md §2 ④ payment_channel_limit·§5, BUILD_ORDER PRF-203).
// 프레임워크·저장소를 모른다(순수 값과 함수). 보호기(pg-call-guard.ts)가 이 값을 쓰고, 표 맞추기(application/pg-channel-limit-sync.ts)가 겨룸에서 진 쓰기를 이것으로 판정한다.
import type { PgName } from './payment-gateway.js';

/** 한 번 낮춘 뒤 다시 낮추지 않는 시간 5초 [가정](같은 순간에 몰린 429가 연달아 낮추지 않게, 파드 사이에도 같다) */
export const PG_LOWER_COOLDOWN_MS = 5_000;
/** 낮추기 하한(처음 상한의 25% [가정]) */
export const PG_LIMIT_FLOOR_PERCENT = 25;
/** 낮추지 않은 비율 */
export const PG_LIMIT_FULL_PERCENT = 100;
/** 낮춘 값을 두는 시간 70분 [추측](온세일 몰림 1시간 [추측] + 승인 기한 10분. 정할 곳: R1 검토, wbs 2.12.1) */
export const PG_LIMIT_HOLD_MS = 70 * 60_000;
/** 파드가 표를 다시 읽는 간격 1초 [가정] */
export const PG_LIMIT_SYNC_MS = 1_000;
/** 표 쓰기가 판 번호에 졌을 때 더 해 보는 횟수 2번 [가정] */
export const PG_LIMIT_WRITE_RETRIES = 2;

/** payment_channel_limit 한 행(channel = 'ALL') */
export interface PgChannelLimitRow {
  readonly pg: PgName;
  /** 처음 상한(파드당) 대비 퍼센트, 25~99 */
  readonly ratioPercent: number;
  /** 마지막으로 낮춘 시각(쓴 파드의 벽시계, ms) */
  readonly loweredAtMs: number;
  /** 이 시각부터 처음 상한이다(ms) */
  readonly expiresAtMs: number;
  readonly version: number;
}

/** 파드가 낮춘 한 번(표에 쓸 값) */
export interface PgLimitLowering {
  readonly pg: PgName;
  readonly ratioPercent: number;
  readonly loweredAtMs: number;
  readonly expiresAtMs: number;
  /** 429를 받은 호출을 시작한 벽시계 시각(ms). 모르면 없다 */
  readonly callStartedAtMs?: number;
  /** 낮출 때 그 파드가 알던 표 행(판 번호 조건). 없으면 판 번호 1의 INSERT다 */
  readonly basis?: PgChannelLimitRow;
}

/** 아직 만료되지 않았는가(만료 시각을 포함해 그 뒤는 처음 상한이다) */
export const isLimitLive = (row: { readonly expiresAtMs: number } | undefined, nowMs: number): row is { readonly expiresAtMs: number } => row !== undefined && nowMs < row.expiresAtMs;

/** 새 비율 = max(25, 유효 비율 ÷ 2의 내림) */
export function halvedRatio(effectivePercent: number): number {
  return Math.max(PG_LIMIT_FLOOR_PERCENT, Math.floor(effectivePercent / 2));
}

/**
 * 표 행이 이미 이 낮춤을 담고 있는가(겨룸에서 진 쪽이 다시 읽은 행으로 판정한다. 참이면 쓰지 않는다).
 * 살아 있는 행이 ① 이번 값 이하이거나 ② 이번 낮춤 앞 5초 [가정] 안에 낮춘 것이거나 ③ 이번 429를 받은 호출이 시작된 뒤에 낮춘 것이면 참이다.
 */
export function loweringCovered(row: PgChannelLimitRow | undefined, lowering: PgLimitLowering): boolean {
  if (row === undefined || !isLimitLive(row, lowering.loweredAtMs)) return false;
  if (row.ratioPercent <= lowering.ratioPercent) return true;
  if (row.loweredAtMs > lowering.loweredAtMs - PG_LOWER_COOLDOWN_MS) return true;
  return lowering.callStartedAtMs !== undefined && lowering.callStartedAtMs < row.loweredAtMs;
}
