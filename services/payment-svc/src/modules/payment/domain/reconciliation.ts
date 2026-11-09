// 일일 대사의 값과 규칙(docs/features/payment.md §8 '대사의 첫 구현', docs/data.md reconciliation_run·reconciliation_diff·reconciliation_seen, BUILD_ORDER HOT-153, ADR-0044·0086).
// 실행기(application/payment-reconciliation.ts)와 저장소가 쓴다. 프레임워크·저장소·계약 패키지를 모른다(순수 값과 함수).
// 구현에서 정한 것(정본·설계에 없다):
// - 결제사 승인 + 원장 입금 대기와, 결과 모름의 결제사 실패·만료·입금 대기도 단독 조회로 넘긴다(조회가 끝낸다).
// - 금액은 결제사 승인일 때만 견준다(취소 줄의 금액은 취소 금액이다).
// - 주문 ID가 다르면 금액·상태를 보기 전에 불일치다(다른 주문의 거래로 원장을 바꾸지 않는다).
// - 원장 없음은 돈이 남아 있는 거래(승인·부분 취소)만 불일치다.
import type { PaymentLedgerStatus } from './confirm-command.js';
import type { PgName, QueryStatus } from './payment-gateway.js';

/** 정비 일 이름 */
export const RECONCILIATION_TASK = 'payment-reconciliation';
export const DEPOSIT_HASH_DELETE_TASK = 'deposit-secret-hash-delete';
export const RECON_SEEN_DELETE_TASK = 'reconciliation-seen-delete';

/** 결제사 조회 한 번의 거래 수 1,000건 [가정] */
export const RECON_PAGE_LIMIT = 1_000;
/** 결제사 조회 한 번의 시간 한도 60초(토스 거래 조회 응답 기한, payment §2.1) */
export const RECON_PAGE_TIMEOUT_MS = 60_000;
/** 대사 조회가 쓰는 호출 몫: 초당 상한의 10% [가정](설계 1) */
export const RECON_TOKEN_SHARE_PERCENT = 10;
/** 토큰을 기다리며 다시 보는 간격 50ms [가정] */
export const RECON_TOKEN_POLL_MS = 50;
/** 일시 실패한 묶음을 다시 부르는 횟수 3번 [가정](넘으면 그 실행을 실패로 끝낸다) */
export const RECON_PAGE_RETRIES = 3;
/** 다시 부르기 전 쉬는 시간의 시작 1초 [가정](두 배씩 늘린다) */
export const RECON_RETRY_BASE_MS = 1_000;
/** 온세일 윈도우가 이어져도 늦어도 시작하는 KST 시각 04시 [가정](payment §8) */
export const RECON_LATEST_START_KST_HOUR = 4;
/** 끝내지 못한 날짜를 되돌아보는 기간 7일 [가정] */
export const RECON_LOOKBACK_DAYS = 7;
/** 결제사 조회 범위를 대상 날짜 앞뒤로 넓히는 폭 10분 [가정](결제사 시각과 원장 시각이 자정 앞뒤로 갈려 없는 거래로 잡히지 않게) */
export const RECON_MARGIN_MS = 10 * 60_000;
/** 맞추기·원장 쪽 묶음 크기 1,000건 [가정] */
export const RECON_BATCH = 1_000;
/** 입금 secret 해시를 지우는 기준: 입금 확정 뒤 90일 [가정](payment-svc는 회차 끝 시각을 모른다, payment §6 '해시 수명') */
export const DEPOSIT_SECRET_HASH_RETENTION_MS = 90 * 86_400_000;
/** 입금 secret 해시를 한 번에 비우는 수 1,000건 [가정] */
export const DEPOSIT_SECRET_HASH_DELETE_BATCH = 1_000;
/** 작업 표를 한 번에 지우는 수 5,000건 [가정] */
export const RECON_SEEN_DELETE_BATCH = 5_000;
/** 결과 모름 당기기 한 번의 건수 상한 50건 [가정](단독 조회가 한 번에 잡는 수와 같다. 승인과 나눠 쓰는 토큰을 한꺼번에 먹지 않게, BUILD_ORDER HOT-153 코드 리뷰 M10) */
export const RECON_PULL_BATCH = 50;
/** 결과 모름 당기기 묶음 사이에 쉬는 시간 1초 [가정](단독 조회 잡기 주기와 같다) */
export const RECON_PULL_PAUSE_MS = 1_000;
/** 결제사가 429로 답했을 때 다시 부르기 전에 쉬는 최소 시간 5초 [가정](호출 보호의 낮춤 간격과 같다) */
export const RECON_THROTTLE_BACKOFF_MS = 5_000;
/** 실행 하나에서 건마다 내는 SEV1의 상한 100건 [가정](체계적 원인으로 경보가 쏟아지지 않게. 넘으면 끝에 한 줄로 요약한다. 기록과 지표는 모두 남긴다) */
export const RECON_SEV1_LIMIT = 100;
/** 다시 확인·닫기 전 대조 조회를 일시 실패로 다시 부르는 횟수 3번 [가정](거래 조회 묶음과 같다) */
export const RECON_QUERY_RETRIES = RECON_PAGE_RETRIES;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const KST_OFFSET_MS = 9 * HOUR_MS;

/** payment_reconciliation_mismatches_total{kind}와 reconciliation_diff.kind의 값 */
export const RECON_DIFF_KINDS = [
  'PG_APPROVED_NO_LEDGER',
  'PG_MISMATCH',
  'AMOUNT_MISMATCH',
  'ORDER_MISMATCH',
  'LEDGER_APPROVED_PG_NOT_PAID',
  'LEDGER_APPROVED_NO_PG_RECORD',
  'LEDGER_FAILED_PG_APPROVED',
  'PARTIAL_CANCELED_AT_PG',
  'LEDGER_CANCELED_PG_APPROVED',
  'UNKNOWN_HANDED_OFF',
  'UNKNOWN_CANCELED_CLOSED',
  'UNREADABLE',
] as const;
export type ReconDiffKind = (typeof RECON_DIFF_KINDS)[number];

/** reconciliation_diff.state: OPEN 사람이 본다, HANDED_OFF 단독 조회로 넘겼다, CLOSED 원장을 닫았다 */
export type ReconDiffState = 'OPEN' | 'HANDED_OFF' | 'CLOSED';
/** PULLING: 원장 쪽을 끝내고 결과 모름 당기기만 남았다(이어 해도 원장 쪽을 다시 돌지 않는다, BUILD_ORDER HOT-153 코드 리뷰) */
export type ReconStage = 'LISTING' | 'COMPARING' | 'LEDGER' | 'PULLING';
export type ReconRunStatus = 'RUNNING' | 'DONE' | 'FAILED';

/** 다른 실행이 세대를 올려 이 실행의 쓰기가 거절됐다(리더가 바뀌었다, BUILD_ORDER HOT-153 코드 리뷰 H1). 실패가 아니라 멈춤이다 */
export class ReconRunLostError extends Error {
  readonly code = 'RECON_RUN_LOST';
  constructor() {
    super('대사 실행의 소유권을 잃었다');
    this.name = 'ReconRunLostError';
  }
}

/** 결제사 쪽 한 줄(작업 표 reconciliation_seen의 칸, 대상 범위 안의 마지막 거래) */
export interface ReconSeen {
  readonly paymentRef: string;
  /** 결제사가 준 주문 참조 */
  readonly orderRef: string;
  readonly pgStatus: QueryStatus;
  readonly amount: number;
}

/** 원장 쪽 한 줄 */
export interface ReconLedger {
  readonly paymentId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly attemptNo: number;
  readonly pg: PgName;
  readonly paymentRef: string;
  readonly amount: number;
  readonly status: PaymentLedgerStatus;
  readonly txId?: string;
  /** 원장 상태가 바뀐 시각(epoch ms). 대상 날짜 끝 뒤면 목록 값과 견주지 않고 단독 조회로 다시 확인한다(BUILD_ORDER HOT-153 코드 리뷰 H2) */
  readonly statusChangedAtMs?: number;
}

/**
 * 비교 결과. MATCH는 맞음이고, DIFF는 reconciliation_diff에 쓴다.
 * - action REQUERY: next_query_at = 지금(단독 조회로 넘긴다) · CLOSE_CANCELED: 원장을 CANCELED로 닫는다 · NONE: 사람이 본다
 * - sev1: 건마다 한 번 SEV1 로그를 낸다. csCase는 그 로그에 싣는다
 */
export type ReconDecision =
  | { readonly kind: 'MATCH' }
  | { readonly kind: 'DIFF'; readonly diff: ReconDiffKind; readonly action: 'NONE' | 'REQUERY' | 'CLOSE_CANCELED'; readonly sev1: boolean; readonly csCase?: 'PAYMENT_LATE_DEPOSIT' };

/** 끝내지 못한 실행 표 행(pendingDates의 결과) */
export interface ReconRunRef {
  readonly date: string;
  readonly status: ReconRunStatus;
  /** FAILED로 끝난 시각(epoch ms) */
  readonly finishedAtMs?: number;
}

/** KST 하루의 시작(epoch ms) */
function kstDayStartMs(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
}

/** KST 날짜 글자(YYYY-MM-DD) */
function kstDateOf(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 시작해도 되는가(payment §8, BUILD_ORDER HOT-153 코드 리뷰 M10·M11).
 * 전날 ± 10분을 받아야 하므로 00:10 전에는 DEFER, 낮에 프로세스가 다시 떠도 돌지 않게 05시부터는 DEFER다. 그 사이에서 04시 [가정] 전이고 대형·중형 온세일 윈도우 안이면 DEFER, 그 밖은 START다.
 * @param nowMs 지금(epoch ms)
 * @param onSaleActive 지금이 대형·중형 온세일 윈도우 안인가
 */
export function reconStartDecision(nowMs: number, onSaleActive: boolean): 'START' | 'DEFER' {
  const sinceMidnightMs = nowMs - kstDayStartMs(nowMs);
  const kstHour = Math.floor(sinceMidnightMs / HOUR_MS);
  if (sinceMidnightMs < RECON_MARGIN_MS || kstHour > RECON_LATEST_START_KST_HOUR) return 'DEFER';
  return onSaleActive && kstHour < RECON_LATEST_START_KST_HOUR ? 'DEFER' : 'START';
}

/** 되돌아보는 기간의 날짜(KST, 오래된 차례): 전날까지 RECON_LOOKBACK_DAYS일 */
export function reconWindowDates(nowMs: number): string[] {
  const yesterdayStart = kstDayStartMs(nowMs) - DAY_MS;
  return Array.from({ length: RECON_LOOKBACK_DAYS }, (_, i) => kstDateOf(yesterdayStart - (RECON_LOOKBACK_DAYS - 1 - i) * DAY_MS));
}

/** 원장 상태가 대상 날짜 끝 뒤에 바뀌었는가(그날 목록 값과 견주면 시점 차이로 오탐한다, BUILD_ORDER HOT-153 코드 리뷰 H2) */
export function reconChangedAfterDay(ledger: Pick<ReconLedger, 'statusChangedAtMs'>, date: string): boolean {
  return ledger.statusChangedAtMs !== undefined && ledger.statusChangedAtMs >= reconRangeOf(date).toMs;
}

/** 대상 날짜 안의 시각인가. 같은 결제 참조의 줄을 고를 때 대상 날짜 안의 줄을 여백의 줄보다 앞세운다(BUILD_ORDER HOT-153 코드 리뷰 M9) */
export function reconInDay(atMs: number, date: string): boolean {
  const { fromMs, toMs } = reconRangeOf(date);
  return atMs >= fromMs && atMs < toMs;
}

/** 대상 날짜(KST, YYYY-MM-DD) = 지금의 전날 */
export function reconDateOf(nowMs: number): string {
  return kstDateOf(kstDayStartMs(nowMs) - DAY_MS);
}

/** 그 날짜(KST)의 범위 [fromMs, toMs). @throws RangeError 날짜 모양이 아님 */
export function reconRangeOf(date: string): { readonly fromMs: number; readonly toMs: number } {
  const fromMs = Date.parse(`${date}T00:00:00+09:00`);
  if (Number.isNaN(fromMs)) throw new RangeError(`날짜가 아니다: ${date}`);
  return { fromMs, toMs: fromMs + DAY_MS };
}

/** 결제사 조회 범위: 대상 날짜 앞뒤로 RECON_MARGIN_MS 넓힌다 */
export function reconListRangeOf(date: string): { readonly fromMs: number; readonly toMs: number } {
  const { fromMs, toMs } = reconRangeOf(date);
  return { fromMs: fromMs - RECON_MARGIN_MS, toMs: toMs + RECON_MARGIN_MS };
}

/**
 * 이번에 돌 날짜(오래된 차례): 되돌아보는 기간의 날짜를 모두 나열해 행이 없거나 끝내지 못한 날(RUNNING, 오늘 전에 실패한 FAILED, 설계 '다음 날 다시')을 고른다.
 * 행이 없는 날도 빠뜨리지 않는다(그날 프로세스가 돌지 않아도 정산이 보는 DONE을 채운다, BUILD_ORDER HOT-153 코드 리뷰 H4).
 * @param rows 되돌아보는 기간 안의 행(DONE 포함)
 * @param nowMs 지금(epoch ms)
 */
export function reconTargets(rows: readonly ReconRunRef[], nowMs: number): string[] {
  const todayStart = kstDayStartMs(nowMs);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return reconWindowDates(nowMs).filter((date) => {
    const r = byDate.get(date);
    if (r === undefined || r.status === 'RUNNING') return true;
    return r.status === 'FAILED' && (r.finishedAtMs === undefined || r.finishedAtMs < todayStart);
  });
}

/** 대사가 쓰는 초당 호출 = 채널 상한의 10% [가정] */
export function reconciliationCallsPerSecond(channelCallsPerSecond: number): number {
  return (channelCallsPerSecond * RECON_TOKEN_SHARE_PERCENT) / 100;
}

const MATCH: ReconDecision = { kind: 'MATCH' };
const sev1 = (diff: ReconDiffKind): ReconDecision => ({ kind: 'DIFF', diff, action: 'NONE', sev1: true });
const HAND_OFF: ReconDecision = { kind: 'DIFF', diff: 'UNKNOWN_HANDED_OFF', action: 'REQUERY', sev1: false };
const CLOSE_CANCELED: ReconDecision = { kind: 'DIFF', diff: 'UNKNOWN_CANCELED_CLOSED', action: 'CLOSE_CANCELED', sev1: false };
const LATE_DEPOSIT: ReconDecision = { kind: 'DIFF', diff: 'LEDGER_FAILED_PG_APPROVED', action: 'NONE', sev1: true, csCase: 'PAYMENT_LATE_DEPOSIT' };
/** 돈이 남아 있는 결제사 상태 */
const HAS_MONEY = (s: QueryStatus): boolean => s === 'APPROVED' || s === 'PARTIAL_CANCELED';

/** 결제사 쪽 한 줄과 원장 쪽 한 줄을 견준다(payment §8 '비교 표'). 원장을 못 찾았으면 ledger undefined. 던지지 않는다 */
export function decideReconciliation(seen: ReconSeen, ledger: ReconLedger | undefined, runPg: PgName): ReconDecision {
  if (ledger === undefined) return HAS_MONEY(seen.pgStatus) ? sev1('PG_APPROVED_NO_LEDGER') : MATCH;
  if (ledger.pg !== runPg) return sev1('PG_MISMATCH');
  if (seen.orderRef !== ledger.orderId) return sev1('ORDER_MISMATCH');
  if (seen.pgStatus === 'APPROVED' && seen.amount !== ledger.amount) return sev1('AMOUNT_MISMATCH');
  switch (ledger.status) {
    case 'APPROVED':
      if (seen.pgStatus === 'APPROVED') return MATCH;
      return seen.pgStatus === 'PARTIAL_CANCELED' ? sev1('PARTIAL_CANCELED_AT_PG') : sev1('LEDGER_APPROVED_PG_NOT_PAID');
    case 'UNKNOWN':
      switch (seen.pgStatus) {
        case 'CANCELED':
          return CLOSE_CANCELED;
        case 'PARTIAL_CANCELED':
          return sev1('PARTIAL_CANCELED_AT_PG');
        case 'READY':
        case 'IN_PROGRESS':
          return MATCH;
        default:
          return HAND_OFF;
      }
    case 'AWAITING_DEPOSIT':
      if (seen.pgStatus === 'WAITING_FOR_DEPOSIT' || seen.pgStatus === 'READY' || seen.pgStatus === 'IN_PROGRESS') return MATCH;
      return seen.pgStatus === 'PARTIAL_CANCELED' ? sev1('PARTIAL_CANCELED_AT_PG') : HAND_OFF;
    case 'FAILED':
      return HAS_MONEY(seen.pgStatus) ? LATE_DEPOSIT : MATCH;
    case 'CANCELED':
    case 'PARTIAL_CANCELED':
      return seen.pgStatus === 'APPROVED' ? sev1('LEDGER_CANCELED_PG_APPROVED') : MATCH;
    default:
      return MATCH;
  }
}

/** 결제사 기록이 없는 원장 한 줄(원장 쪽 단계). 승인 원장만 불일치다 */
export function decideLedgerOnly(ledger: Pick<ReconLedger, 'status'>): ReconDecision {
  return ledger.status === 'APPROVED' ? sev1('LEDGER_APPROVED_NO_PG_RECORD') : MATCH;
}
