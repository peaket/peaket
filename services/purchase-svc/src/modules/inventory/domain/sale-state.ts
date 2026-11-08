// 회차 판매 상태 판정의 규칙 값·타입·순수 함수(docs/features/seat-hold.md §4 '판정의 첫 구현', ADR-0122 '뒤에 정한 것', ADR-0214 결정 2·3, ADR-0219 결정 5·6, BUILD_ORDER PRF-144, S-T25).
// 판정 하나의 결과는 decideSale이 정한다. 언제 어떤 셈을 읽고 어떻게 쓰는지는 application/sale-state-judge.ts다. 도메인 층이라 프레임워크·플랫폼 형을 가져오지 않는다.
import { uuid8 } from './purchase-session.js';

/** 회차 판매 상태 다섯(ADR-0122 결정 1). ENDED 뒤에는 바뀌지 않는다 */
export type SaleStatus = 'UPCOMING' | 'ON_SALE' | 'ALL_HELD' | 'SOLD_OUT' | 'ENDED';

/** 표의 CHECK와 같은 다섯 상태 */
export const SALE_STATUSES: readonly SaleStatus[] = ['UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED'];

/** 판정 반복 주기 1초 [가정](ADR-0122 결정 3) */
export const SALE_TICK_MS = 1000;
/** 가용 0이 이만큼 이어지면 ON_SALE → ALL_HELD. 5초 [가정](ADR-0122 결정 3) */
export const ALL_HELD_AFTER_MS = 5000;
/** 상태가 그대로여도 같은 판을 다시 내는 간격 5초 [가정](ADR-0219 결정 5) */
export const SALE_REPUBLISH_MS = 5000;
/** 회차·등급이 비었다고 보려면 이어져야 하는 틱 수(ADR-0122 결정 3, ADR-0214 결정 3) */
const EMPTY_TICKS_TO_SOLD_OUT = 2;
/** avgTicketsPerOrder를 싣는 결제 끝난 주문 수의 하한 100건 [가정](ADR-0219 결정 6) */
export const AVG_MIN_ORDERS = 100;
/** 평균 구매 매수를 파드 메모리에 두는 시간 1분 [가정](5초마다 큰 셈을 하지 않게) */
export const AVG_CACHE_MS = 60_000;
/** 등급 홀드를 볼 때 만료 인덱스에서 한 번에 읽는 수 1,000개 [가정] */
export const SALE_TIER_SCAN_PAGE = 1000;
/** 한 틱에 동시에 판정하는 회차 수의 상한 4 [가정](ExpirySweeper와 같다) */
export const SALE_JUDGE_CONCURRENCY = 4;
/** 판정 실패 경고 로그를 파드마다 남기는 최소 간격 1분 [가정] */
export const SALE_WARN_INTERVAL_MS = 60_000;
/** event_sale 쓰기 트랜잭션의 문장 시간 한도 5초 [가정](요청 밖의 다른 반복과 같다. 멈춘 문장이 다음 틱을 계속 막지 않게) */
export const SALE_STATEMENT_TIMEOUT_MS = 5000;

/** 판매 대상 좌석 색인을 모은 등급 하나(좌석맵 판의 판매 제외석은 없다) */
export interface SaleTierIndexes {
  tierId: string;
  /** 판매 대상 좌석의 비트맵 색인(오름차순) */
  indexes: readonly number[];
}

/** 회차의 판매 대상 좌석표(SeatMapTiers.saleLayout) */
export interface SaleLayout {
  /** 판매 대상 좌석 수(모든 tiers.indexes 길이의 합) */
  sellableSeats: number;
  /** 등급별 색인(등급 ID 문자 코드 순) */
  tiers: readonly SaleTierIndexes[];
}

/** 표와 사건에 싣는 셈 셋 */
export interface SaleSeatCounts {
  /** 판매 대상 좌석 가운데 비트가 꺼진 수(등급 가용의 합) */
  available: number;
  /** 만료 인덱스의 수(우선 구매 보류·멈춘 홀드는 GAT-135·HOT-070이 더한다) */
  held: number;
  /** 결제 중(승인 결과를 기다리는 PENDING, 등급 합) */
  paying: number;
}

/** 등급 하나의 셈 */
export interface SaleTierCounts {
  tierId: string;
  available: number;
  paying: number;
  /**
   * 이 등급에 홀드가 있는가(만료 인덱스를 읽어 그 등급의 색인을 본 때만 참). 회차의 held가 0이면 거짓이다.
   * 후보 등급(가용·결제 중이 0)이 아니면 읽지 않으므로 거짓이고, 그 값은 판정에 쓰이지 않는다
   */
  held: boolean;
}

/** 한 틱의 셈(judge가 Redis·DB 읽기를 모아 만든다) */
export interface SaleCounts extends SaleSeatCounts {
  /**
   * 회차 전체가 비었는가(거짓 매진 막기를 지남): available·held·paying이 모두 0이고, 활성 판매 행(PENDING·SOLD) 수가
   * sellableSeats − available(곧 켜진 비트 수)과 같을 때만 참. 셋이 0이어도 수가 다르면 거짓이다
   */
  empty: boolean;
  /**
   * SOLD_OUT에서 가용이 생겼지만 활성 판매 행 수가 판매 대상 좌석 수에 닿아 있어 풀면 안 되는가(리뷰 고침 L6, 2026-11-09).
   * 팔린 좌석의 비트만 잃은 장애 조치(복제되지 않은 쓰기를 잃고 주 노드가 바뀐 때)로 거짓 취소표 알림이 나가지 않게 한다. 참이면 SOLD_OUT과 매진 등급을 그대로 둔다
   */
  reopenBlocked?: boolean;
  /** 등급별 셈(SaleLayout.tiers와 같은 차례). 등급이 없으면 빈 배열 */
  tiers: readonly SaleTierCounts[];
}

/** 틱 사이에 파드 메모리에 두는 값(회차마다, 임대가 넘어가면 없어진다. 없으면 판정이 그만큼 늦을 뿐이다) */
export interface SaleMemo {
  /** 가용이 0이 된 첫 틱의 시각(epoch ms). 가용이 1 이상이면 없다 */
  availableZeroSinceMs?: number;
  /** counts.empty가 참인 틱이 이어진 수. 거짓이면 0 */
  emptyStreak: number;
  /** 지금 이어지는 빈 틱 가운데 첫 틱의 시각(epoch ms). 비지 않으면 없다(리뷰 고침 L7, 틱이 몰려도 1초를 지키게) */
  firstEmptyAtMs?: number;
  /** 등급 ID → 그 등급의 가용·홀드·결제 중이 0인 틱이 이어진 수(0은 넣지 않는다) */
  tierEmptyStreak: ReadonlyMap<string, number>;
}

/** 빈 메모(처음과, 다른 파드에 진 뒤) */
export const NEW_SALE_MEMO: SaleMemo = Object.freeze({ emptyStreak: 0, tierEmptyStreak: new Map<string, number>() });

/** decideSale이 보는 행의 칸(행이 없으면 row는 undefined) */
export interface SaleRowView {
  status: SaleStatus;
  /** 지금 매진인 등급 ID(정렬됨) */
  soldOutTiers: readonly string[];
  /** UPCOMING의 오픈 시각(epoch ms). 비면 없다 */
  openAtMs?: number;
  reopenCount: number;
}

/** decideSale 입력 */
export interface SaleDecideInput {
  /** 지금 행. 없으면 undefined(이번 판정이 행을 만든다) */
  row: SaleRowView | undefined;
  counts: SaleCounts;
  memo: SaleMemo;
  /** 지금(epoch ms, 주입 Clock) */
  nowMs: number;
  /** 판매 종료 시각(epoch ms, EventSeatConfig.saleEndsAtMs) */
  saleEndsAtMs: number;
}

/** 판정의 까닭(로그·시험용) */
export type SaleDecisionReason =
  /** 행이 없어 ON_SALE로 만든다 */
  | 'NEW_ROW'
  /** 어느 상태든 판매 종료 시각이 지났다 */
  | 'SALE_ENDED'
  /** UPCOMING의 오픈 시각이 지났거나 비었다 */
  | 'OPENED'
  /** SOLD_OUT에서 가용이 생겼다(reopenCount + 1) */
  | 'REOPENED'
  /** 비었음이 두 번 이어졌다 */
  | 'SOLD_OUT'
  /** ON_SALE에서 가용 0이 5초 이어졌다 */
  | 'ALL_HELD'
  /** ALL_HELD에서 가용이 생겼다 */
  | 'AVAILABLE_AGAIN'
  /** 상태는 그대로이고 매진 등급만 바뀌었다 */
  | 'TIERS_CHANGED'
  /** 바꿀 것이 없다 */
  | 'UNCHANGED';

/** decideSale 결과 */
export interface SaleDecision {
  /** 다음 상태 */
  status: SaleStatus;
  /** 다음 매진 등급(등급 ID 문자 코드 순, 겹침 없음) */
  soldOutTiers: readonly string[];
  /** 다음 reopenCount(행이 없으면 0) */
  reopenCount: number;
  /** 다음 메모 */
  memo: SaleMemo;
  /** status 또는 soldOutTiers 집합이 바뀌었는가. 행을 새로 만들면 참(판 번호를 올려 사건을 낸다). 행이 없고 판매 종료가 지났으면 거짓이다(만들지 않는다) */
  changed: boolean;
  reason: SaleDecisionReason;
}

/**
 * 판정 하나(ADR-0122 결정 3, seat-hold §4 '판정 차례'·'등급 매진'). 던지지 않는다. 입력을 바꾸지 않는다.
 *
 * 메모 갱신(ENDED로 끝나는 판정 말고는 항상):
 * - availableZeroSinceMs: counts.available이 0이면 있던 값을 두거나 없으면 nowMs, 1 이상이면 없앤다.
 * - emptyStreak: counts.empty가 참이면 + 1, 거짓이면 0.
 * - firstEmptyAtMs: counts.empty가 참이면 있던 값을 두거나 없으면 nowMs, 거짓이면 없앤다.
 * - tierEmptyStreak: 등급마다 available·paying이 0이고 held가 거짓이면 + 1, 아니면 그 등급을 뺀다. counts.tiers에 없는 등급도 뺀다.
 *
 * 차례(앞에서 맞는 것 하나):
 * 1. nowMs ≥ saleEndsAtMs 또는 row.status가 ENDED: ENDED. row가 undefined면 soldOutTiers 빈 배열, reopenCount 0, changed 거짓, reason SALE_ENDED다(행도 사건도 만들지 않는다.
 *    ON_SALE을 낸 다음 틱에 ENDED를 내지 않게). row가 있으면 그 행의 soldOutTiers·reopenCount 그대로이고, 이미 ENDED였으면 changed 거짓·UNCHANGED, 아니면 SALE_ENDED다.
 * 2. row가 undefined: ON_SALE, soldOutTiers 빈 배열, reopenCount 0, changed 참, reason NEW_ROW.
 * 3. UPCOMING: openAtMs가 없거나 nowMs ≥ openAtMs면 ON_SALE(OPENED), 아니면 그대로.
 * 4. SOLD_OUT: available ≥ 1이고 counts.reopenBlocked가 아니면 ON_SALE(REOPENED, reopenCount + 1). 0이면 held·paying이 있어도 SOLD_OUT 그대로다.
 *    reopenBlocked면 상태도 매진 등급도 그대로이고 changed 거짓·UNCHANGED다(등급의 가용이 잃은 비트에서 나온 값이라 믿지 않는다).
 * 5. ON_SALE·ALL_HELD에서 갱신한 emptyStreak ≥ 2이고 nowMs − firstEmptyAtMs ≥ SALE_TICK_MS: SOLD_OUT(틱이 몰려 두 번이 1초 안이면 아직이다).
 * 6. ON_SALE에서 availableZeroSinceMs가 있고 nowMs − availableZeroSinceMs ≥ ALL_HELD_AFTER_MS: ALL_HELD.
 * 7. ALL_HELD에서 available ≥ 1: ON_SALE(AVAILABLE_AGAIN).
 * 8. 그 밖은 상태 그대로.
 *
 * 등급 매진(1번·2번으로 끝나는 판정 말고는 위 차례의 결과와 함께 낸다): 이미 든 등급은 그 등급의 available ≥ 1이면 뺀다(counts.tiers에 없는 등급은 그대로 둔다).
 * 들지 않은 등급은 갱신한 streak ≥ 2이면 더한다(회차 매진과 달리 틱 수만 본다. 대기를 끝내지 않고 가용이 생기면 바로 빠지기 때문이다). 결과는 정렬한다. 상태가 그대로인데 집합이 바뀌면 changed 참, reason TIERS_CHANGED다.
 *
 * @returns 다음 값. 행을 쓰는 일은 부르는 쪽이 한다
 */
export function decideSale(input: SaleDecideInput): SaleDecision {
  const { row, counts, memo, nowMs, saleEndsAtMs } = input;
  if (nowMs >= saleEndsAtMs || row?.status === 'ENDED') {
    if (!row) return { status: 'ENDED', soldOutTiers: [], reopenCount: 0, memo, changed: false, reason: 'SALE_ENDED' };
    const changed = row.status !== 'ENDED';
    return { status: 'ENDED', soldOutTiers: [...row.soldOutTiers], reopenCount: row.reopenCount, memo, changed, reason: changed ? 'SALE_ENDED' : 'UNCHANGED' };
  }
  const nextMemo = nextMemoOf(counts, memo, nowMs);
  if (!row) return { status: 'ON_SALE', soldOutTiers: [], reopenCount: 0, memo: nextMemo, changed: true, reason: 'NEW_ROW' };
  if (row.status === 'SOLD_OUT' && counts.reopenBlocked) return { status: 'SOLD_OUT', soldOutTiers: [...row.soldOutTiers], reopenCount: row.reopenCount, memo: nextMemo, changed: false, reason: 'UNCHANGED' };

  const soldOutTiers = nextSoldOutTiers(row.soldOutTiers, counts.tiers, nextMemo.tierEmptyStreak);
  const transition = transitionOf(row, counts, nextMemo, nowMs);
  if (transition) return { status: transition.status, soldOutTiers, reopenCount: row.reopenCount + (transition.reason === 'REOPENED' ? 1 : 0), memo: nextMemo, changed: true, reason: transition.reason };
  const changed = !sameTiers(row.soldOutTiers, soldOutTiers);
  return { status: row.status, soldOutTiers, reopenCount: row.reopenCount, memo: nextMemo, changed, reason: changed ? 'TIERS_CHANGED' : 'UNCHANGED' };
}

/** 이번 틱의 셈을 메모에 더한다(decideSale 머리 주석의 '메모 갱신') */
function nextMemoOf(counts: SaleCounts, memo: SaleMemo, nowMs: number): SaleMemo {
  const tierEmptyStreak = new Map<string, number>();
  for (const t of counts.tiers) {
    if (t.available === 0 && t.paying === 0 && !t.held) tierEmptyStreak.set(t.tierId, (memo.tierEmptyStreak.get(t.tierId) ?? 0) + 1);
  }
  return {
    ...(counts.available === 0 ? { availableZeroSinceMs: memo.availableZeroSinceMs ?? nowMs } : {}),
    emptyStreak: counts.empty ? memo.emptyStreak + 1 : 0,
    ...(counts.empty ? { firstEmptyAtMs: memo.firstEmptyAtMs ?? nowMs } : {}),
    tierEmptyStreak,
  };
}

/** 살아 있는 행의 상태 전이(decideSale 머리 주석의 3~7번). 그대로면 undefined */
function transitionOf(row: SaleRowView, counts: SaleCounts, memo: SaleMemo, nowMs: number): { status: SaleStatus; reason: SaleDecisionReason } | undefined {
  switch (row.status) {
    case 'UPCOMING':
      return row.openAtMs === undefined || nowMs >= row.openAtMs ? { status: 'ON_SALE', reason: 'OPENED' } : undefined;
    case 'SOLD_OUT':
      return counts.available >= 1 ? { status: 'ON_SALE', reason: 'REOPENED' } : undefined;
    case 'ON_SALE':
    case 'ALL_HELD': {
      if (memo.emptyStreak >= EMPTY_TICKS_TO_SOLD_OUT && memo.firstEmptyAtMs !== undefined && nowMs - memo.firstEmptyAtMs >= SALE_TICK_MS) return { status: 'SOLD_OUT', reason: 'SOLD_OUT' };
      if (row.status === 'ALL_HELD') return counts.available >= 1 ? { status: 'ON_SALE', reason: 'AVAILABLE_AGAIN' } : undefined;
      const since = memo.availableZeroSinceMs;
      return since !== undefined && nowMs - since >= ALL_HELD_AFTER_MS ? { status: 'ALL_HELD', reason: 'ALL_HELD' } : undefined;
    }
    default:
      return undefined;
  }
}

/** 다음 매진 등급(정렬, 겹침 없음) */
function nextSoldOutTiers(current: readonly string[], tiers: readonly SaleTierCounts[], streaks: ReadonlyMap<string, number>): string[] {
  const availableOf = new Map(tiers.map((t) => [t.tierId, t.available]));
  const next = new Set(current.filter((id) => (availableOf.get(id) ?? 0) === 0));
  for (const [id, streak] of streaks) if (streak >= EMPTY_TICKS_TO_SOLD_OUT) next.add(id);
  return [...next].sort();
}

const sameTiers = (a: readonly string[], b: readonly string[]): boolean => {
  const set = new Set(a);
  return set.size === b.length && b.every((id) => set.has(id));
};

/**
 * 비트맵에서 등급별 가용(꺼진 비트 수)을 센다.
 * 색인 i의 비트는 Redis 비트맵 차례(i >> 3번째 바이트의 높은 비트부터, SETBIT·BITFIELD와 같다)다. 비트맵이 짧으면 모자란 곳은 0(가용)으로 본다.
 * tiers의 색인만 보므로 판매 대상이 아닌 색인의 비트는 세지 않는다.
 * @param bitmap 좌석 비트맵(SaleCountsReader.read)
 * @param tiers 판매 대상 색인(SaleLayout.tiers)
 * @returns tiers와 같은 차례의 { tierId, available }
 */
export function tierAvailability(bitmap: Buffer, tiers: readonly SaleTierIndexes[]): { tierId: string; available: number }[] {
  const isTaken = (i: number): boolean => ((bitmap[i >> 3] ?? 0) & (0x80 >> (i & 7))) !== 0;
  return tiers.map(({ tierId, indexes }) => {
    let available = 0;
    for (const i of indexes) if (!isTaken(i)) available += 1;
    return { tierId, available };
  });
}

/**
 * 평균 구매 매수(ADR-0219 결정 6): orders ≥ AVG_MIN_ORDERS이면 seats ÷ orders를 소수 둘째 자리로 반올림한 값, 아니면 undefined.
 * @param seats SOLD 좌석 수(0 이상의 정수)
 * @param orders 그 좌석의 서로 다른 주문 수(0 이상의 정수)
 */
export function avgTicketsOf(seats: number, orders: number): number | undefined {
  if (orders < AVG_MIN_ORDERS) return undefined;
  return Math.round((seats * 100) / orders) / 100;
}

/**
 * EventSaleChanged의 eventKey: uuid8('EventSaleChanged:' + eventId + ':' + version). 같은 판을 다시 내도 같은 값이다.
 * @param eventId 회차 ID
 * @param version 판 번호(1 이상의 정수)
 */
export function saleEventKey(eventId: string, version: number): string {
  return uuid8(`EventSaleChanged:${eventId}:${version}`);
}

/** event_sale 행 하나(시각은 epoch ms, 비면 칸이 없다) */
export interface EventSaleRow extends SaleSeatCounts {
  eventId: string;
  status: SaleStatus;
  previousStatus?: SaleStatus;
  /** 판 번호(1 이상) */
  version: number;
  sellableSeats: number;
  soldOutTiers: readonly string[];
  openAtMs?: number;
  firstSoldOutAtMs?: number;
  reopenCount: number;
  changedAtMs: number;
  countedAtMs: number;
}

/** asyncapi EventSaleChanged의 값(trade.seats, type 칸 없음. queue-svc 처리기는 type 칸이 있으면 좌석 사건으로 건너뛴다) */
export interface EventSaleChangedMessage {
  eventId: string;
  status: SaleStatus;
  previousStatus?: SaleStatus;
  available: number;
  held: number;
  paying: number;
  /** 정렬한 매진 등급(없으면 빈 배열) */
  soldOutTiers: string[];
  version: number;
  changedAt: string;
  countedAt: string;
  eventKey: string;
  avgTicketsPerOrder?: number;
}

/**
 * 행에서 사건 값을 만든다: changedAt·countedAt은 ISO 8601, eventKey는 saleEventKey(행의 회차, 행의 판 번호), soldOutTiers는 정렬한 새 배열.
 * previousStatus·avgTicketsPerOrder는 있을 때만 칸을 싣는다(undefined 칸을 두지 않는다).
 * @param row 쓰고 돌려받은 행(판이 바뀐 사건과 같은 판의 다시 내기 모두)
 * @param avgTicketsPerOrder 평균 구매 매수(avgTicketsOf의 값). 없으면 칸을 뺀다
 */
export function saleChangedPayload(row: EventSaleRow, avgTicketsPerOrder?: number): EventSaleChangedMessage {
  return {
    eventId: row.eventId,
    status: row.status,
    ...(row.previousStatus !== undefined ? { previousStatus: row.previousStatus } : {}),
    available: row.available,
    held: row.held,
    paying: row.paying,
    soldOutTiers: [...row.soldOutTiers].sort(),
    version: row.version,
    changedAt: new Date(row.changedAtMs).toISOString(),
    countedAt: new Date(row.countedAtMs).toISOString(),
    eventKey: saleEventKey(row.eventId, row.version),
    ...(avgTicketsPerOrder !== undefined ? { avgTicketsPerOrder } : {}),
  };
}
