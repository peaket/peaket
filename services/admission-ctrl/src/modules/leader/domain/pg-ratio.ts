// 결제사 묶음 고르기와 낮춘 채널 상한 비율(F-02-2 OPS-310, ADR-0366 결정 4·10, ADR-0226 결정 9, docs/features/payment.md §2 '낮춘 상한의 유지·전파·회복').
// - 묶음 차례: 회차 ctl(명령 6 회차 범위) > 전체 ctl(명령 6 PLATFORM) > 일정 사본 cfg. 둘 다 있을 때만 쓴다
// - 비율: Prometheus `min by (pg) (payment_pg_limit_ratio)`의 결제사별 값. 결제사 이름 묶음(TOSS·PORTONE·SIMULATOR)은 그 결제사 비율, PG_FALLBACK은 읽은 비율의 최솟값을 쓴다.
//   비율이 없거나 25~100 밖이면 100으로 본다. 그 밖의 묶음 이름(lt-* 등)에는 비율을 걸지 않는다. 쓰는 승인 상한 = max(1, 내림(pgTps × 비율 ÷ 100))
// 이 파일은 프레임워크를 모른다.
import type { Pg } from './aimd.js';

/** 결제사 이름 묶음(비율을 거는 묶음) */
export const PG_RATIO_KEYS: readonly string[] = ['TOSS', 'PORTONE', 'SIMULATOR'];
/** 전체 범위 대체 미지정 전환의 묶음 이름(ADR-0366 결정 5) */
export const PG_FALLBACK_GROUP = 'PG_FALLBACK';
/** 받는 비율의 범위(낮춘 상한의 바닥 25%, payment.md §2) */
export const PG_RATIO_MIN = 25;
export const PG_RATIO_MAX = 100;
/** 비율 조회 질의(ADR-0366 결정 10) */
export const PG_RATIO_QUERY = 'min by (pg) (payment_pg_limit_ratio)';

/** 묶음 칸(둘 다 있을 때만 묶음이다) */
export interface PgFields {
  readonly pgKey?: string;
  readonly pgTps?: number;
}

/** 회차 ctl > 전체 ctl > cfg 차례로 결제사 묶음을 고른다(ADR-0366 결정 4). 없으면 결제사 상한을 걸지 않는다 */
export function pgGroupOf(eventCtl: PgFields, platformCtl: PgFields | undefined, plan: PgFields): Pg | undefined {
  for (const f of [eventCtl, platformCtl ?? {}, plan]) if (f.pgKey && f.pgTps) return { key: f.pgKey, tps: f.pgTps };
  return undefined;
}

const validRatio = (v: number | undefined): number | undefined => (v !== undefined && Number.isFinite(v) && v >= PG_RATIO_MIN && v <= PG_RATIO_MAX ? v : undefined);

/** 묶음에 걸 비율(%). 비율을 걸지 않는 묶음이면 undefined */
export function pgRatioOf(key: string, ratios: ReadonlyMap<string, number>): number | undefined {
  if (key === PG_FALLBACK_GROUP) {
    const all = [...ratios.values()].map(validRatio).filter((v): v is number => v !== undefined);
    return all.length > 0 ? Math.min(...all) : PG_RATIO_MAX;
  }
  if (!PG_RATIO_KEYS.includes(key)) return undefined;
  return validRatio(ratios.get(key)) ?? PG_RATIO_MAX;
}

/** 비율을 건 묶음(쓰는 승인 상한 = max(1, 내림(pgTps × 비율 ÷ 100))) */
export function pgWithRatio(pg: Pg, ratios: ReadonlyMap<string, number>): Pg {
  const ratio = pgRatioOf(pg.key, ratios);
  if (ratio === undefined || ratio === PG_RATIO_MAX) return pg;
  return { key: pg.key, tps: Math.max(1, Math.floor((pg.tps * ratio) / 100)) };
}
