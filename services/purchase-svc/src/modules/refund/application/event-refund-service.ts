// 회차 취소 일괄 환불의 쓰임새(BAT-425 GAT-120·GAT-130).
// 취소는 확정 뒤 대상 티켓을 기존 예매 취소 Saga(CancelTicket)로 한 장씩 환불하고,
// 연기는 환급 신청 창(REFUND_WINDOW)을 연 뒤 신청한 티켓만 환불한다.
// 자동 정지(실패율·실패 금액·연속 실패·거절률·서킷), 재시도·멱등·중단/재개·진행률, 팬 알림 Outbox를 남긴다.
// 웨이브 끝 리뷰 K1·K2·C1·C2(transfer-refund §5 '일괄 환불 항목의 주인과 겹침 막기'·'그래도 남는 건'): 항목은 주문 단위로 잡은 쪽만 처리하고(claims),
// 쓰기는 잡기 값·진행 중 상태를 조건으로 한다(0행이면 시도 기록·알림·CS 건 없음). 항목이 FAILED로 끝나면 같은 트랜잭션에서 그 취소 행에 refund_failed_at을 쓴다.
// 다시 보기 2 N1·N2(transfer-refund §3.1 ⑥): 일괄 환불 실패 건(failure_case_at)과 공제 차액 대상(deduction_gap_at)은 확정·항목 끝내기 트랜잭션에서 표시만 하고,
// 다시 열기 포트(csOutbox)가 꽂힌 조립에서는 처리 중에 ops-svc를 부르지 않는다. 건은 runDue 틱 끝 한 곳에서 일괄 환불 실패 → 차액 차례로,
// 5초 [가정] 예산과 잇따른 무응답 멈춤 안에서 행마다 연다(cs-case-reopen.ts, 실패해도 항목 상태는 그대로). 포트가 없는 옛 조립만 처리 중에 한 번 연다.
// F-07-8(ADR-0380, transfer-refund §5·§6): 확정 커밋 뒤 payment-svc 정산 보류 열기, COMPLETED(또는 확정 + 3영업일 [가정]) 뒤 완료 알리기(실패는 틱이 1분 → 5분 → 15분 [가정] 다시),
// 결제사로 보내기 직전의 결제사별 토큰 버킷(R-T52), 쓸어 담기의 늦은 주문 배상 행(R-T46 ④), 틱 끝의 배상 송금 결과 확정(R-T47 ③)을 더했다.
import { randomUUID } from 'node:crypto';
import {
  EventRefundActiveConflict,
  eventRefundCancellationId,
  eventRefundPreviewOf,
  eventRefundRetryDelayMs,
  EVENT_REFUND_AUTO_STOP,
  mergePauses,
  progressOf,
  rateBp,
  type EventCancellationRequest,
  type EventRefundAttemptOutcome,
  type EventRefundItem,
  type EventRefundKind,
  type EventRefundPreview,
  type CompensationOrder,
  type EventRefundFault,
  type EventRefundProgress,
  type EventRefundTarget,
  type RefundPgProvider,
  type RefundPauseReason,
} from '../domain/event-refund.js';
import { CsCaseReopenTick } from './cs-case-reopen.js';
import { compensationRowsOf } from '../domain/compensation.js';
import {
  EVENT_REFUND_CLAIM_EXTEND_BELOW_MS,
  type EventRefundApplyInput,
  type EventRefundCloseWindowInput,
  type EventRefundOutboxMessage,
  type EventRefundPauseInput,
  type EventRefundPreviewInput,
  type EventRefundResumeInput,
  type EventRefundServiceDeps,
  type EventRefundStartInput,
} from '../domain/event-refund-ports.js';
import { parseEventRefundHold, type EventRefundHoldInput, type EventRefundHoldState } from '../domain/event-refund-hold.js';
import type { EventRefundSettlementNotice } from '../domain/event-refund-ports.js';

/** 정산 알리기 다시 부르기 간격 1분 → 5분 → 15분, 그 뒤 15분마다 [가정](ADR-0380 결정 2) */
const SETTLEMENT_NOTICE_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
/** 확정 + 이 영업일이 지나도 COMPLETED가 아니면 그때까지의 환급으로 부분 완료를 알린다 3영업일 [가정](ADR-0380 결정 3) */
export const SETTLEMENT_PARTIAL_BUSINESS_DAYS = 3;
/** 틱 하나가 정산 알리기를 보는 요청 수 [가정] */
const SETTLEMENT_NOTICE_BATCH = 20;
/** 틱 끝 배상 송금 결과 확정의 한 번 상한 50건 [가정](계획 §3 I-06) */
const COMPENSATION_REFRESH_LIMIT = 50;
const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** KST 달력으로 주말을 건너뛴 영업일 더하기(같은 시각). 공휴일 달력은 쓰지 않는다 [가정] */
export function addKstWeekdays(fromMs: number, days: number): number {
  let at = fromMs;
  let left = days;
  while (left > 0) {
    at += DAY_MS;
    const wd = new Date(at + KST_OFFSET_MS).getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return at;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EventRefundErrorCode = 'INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'UNAVAILABLE';

export class EventRefundError extends Error {
  constructor(
    readonly code: EventRefundErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EventRefundError';
  }
}

/** 저장된 진행률의 멈춘 결제사와 사유. 진행률에 결제사 몫이 없는 행(칸 기본값 '{}')은 멈춤 없음으로 본다 */
const pausedOf = (request: EventCancellationRequest): { pg: RefundPgProvider; reason: RefundPauseReason }[] =>
  (request.progress.perPg ?? []).filter((p) => p.state === 'PAUSED' && p.pauseReason !== undefined).map((p) => ({ pg: p.pg, reason: p.pauseReason! }));

/** 끝난 요청(COMPLETED·REJECTED)은 진행률을 다시 쓰지 않는다 */
const ended = (request: EventCancellationRequest): boolean => request.status === 'COMPLETED' || request.status === 'REJECTED';

/** 잡은 주문의 잡기 값과 그 작업자가 아는 기한(늘리면 바뀐다, W9-fix1 N3) */
interface HeldClaim {
  readonly token: string;
  untilMs: number;
}

const statusAfterRun = (
  _request: EventCancellationRequest,
  progress: EventRefundProgress,
  paused: readonly { pg: RefundPgProvider }[],
  windowOpen: boolean,
): EventCancellationRequest['status'] => {
  if (paused.length > 0) return 'PAUSED';
  // 계좌 대기(ACCOUNT_PENDING)는 다시 보내지 않으므로 COMPLETED 셈에서 끝난 항목이다(BUILD_ORDER GAT-090, R-T40 ④)
  if (progress.total > progress.done + progress.failed + progress.notApplied + (progress.accountPending ?? 0)) return windowOpen ? 'REFUND_WINDOW' : 'RUNNING';
  return 'COMPLETED';
};

const FAILURE_ERRORS = new Set(['REJECTED', 'TICKET_NOT_HELD', 'TRANSFER_PENDING', 'ALREADY_ENDED', 'EVENT_STARTED', 'NOT_PAYER', 'CONFLICT']);
/**
 * 결제사로 보내지 않고 끝난 즉시 실패(BAT-420 GAT-110 E1·E2): 보류 취소를 그사이 환급 실행기가 집음, 끝난 표의 취소 행이 없음, 같은 표의 다른 진행 중 취소.
 * 재시도해도 같은 답이라 바로 FAILED로 끝내 CS '일괄 환불 실패'로 넘긴다. 결제사 호출이 아니므로 자동 정지 기록에 넣지 않는다
 */
const IMMEDIATE_FAILURES = new Set(['cancellation-in-progress', 'ticket-already-ended', 'cancellation-conflict']);

/** 항목을 주문별로 묶는다(처음 나온 차례를 지킨다) */
function groupByOrder(items: readonly EventRefundItem[]): Map<string, EventRefundItem[]> {
  const groups = new Map<string, EventRefundItem[]>();
  for (const item of items) {
    const group = groups.get(item.orderId);
    if (group) group.push(item);
    else groups.set(item.orderId, [item]);
  }
  return groups;
}

/** 대상 표 한 장의 일괄 환불 항목. 보류 취소가 있으면 그 행 ID를, 아니면 요청·표로 정해진 취소 ID를 쓴다(BAT-420 GAT-110 E1) */
function itemOf(requestId: string, t: EventRefundTarget, kind: EventRefundKind, nowMs: number): EventRefundItem {
  return {
    requestId,
    orderId: t.orderId,
    ticketId: t.ticketId,
    cancellationId: t.pendingCancellationId ?? eventRefundCancellationId(requestId, t.ticketId),
    pg: t.pg,
    status: 'PENDING',
    attempts: 0,
    ...(kind === 'CANCEL' ? { appliedAtMs: nowMs } : {}),
    ...(kind === 'CANCEL' ? { nextAttemptAtMs: nowMs } : {}),
  };
}

type StopReason = { reason: RefundPauseReason; all: boolean; detail: Record<string, unknown> } | undefined;

/** 결제사 호출 결과를 자동 정지의 결과 값으로 나눈다. 업무 거절은 REJECT, 그 밖의 실패는 FAILURE, 결과 모름은 UNKNOWN */
function outcomeOf(status: 'REFUNDED' | 'REFUND_PENDING' | 'FAILED', error: string | undefined): EventRefundAttemptOutcome {
  if (status === 'REFUNDED') return 'SUCCESS';
  if (status === 'REFUND_PENDING') return 'UNKNOWN';
  return error !== undefined && FAILURE_ERRORS.has(error) ? 'REJECT' : 'FAILURE';
}

/** 미리보기의 주문별 배상 목록을 확정까지 들고 있는 시간 1시간 [가정]. 그 뒤 확정은 옛 호출과 같이 다시 계산한다 */
export const EVENT_REFUND_PREVIEW_TTL_MS = 60 * 60_000;
/** 프로세스 안에 들고 있는 미리보기 수 상한 [가정] */
const EVENT_REFUND_PREVIEW_CACHE = 100;

export class EventRefundService {
  /**
   * 판정 미리보기의 주문별 배상 목록(BAT-425 RV-02). 정본은 ops-svc dry_run이고 확정 요청이 그 목록을 싣는다.
   * 같은 프로세스에서 미리보기 뒤 확정하는 옛 호출자를 위해 마지막 미리보기를 잠시 들고 있다가 쓴다
   */
  readonly #previews = new Map<string, { readonly orders?: readonly CompensationOrder[]; readonly atMs: number }>();

  constructor(private readonly o: EventRefundServiceDeps) {}

  /**
   * 회차 취소 요청 중 보류 취소의 환급 미룸 걸기·늘리기·풀기(BAT-420 몫 D, gRPC SetEventRefundHold).
   * 입력 검사(소문자 UUID·기한 지금 뒤 7일 안)를 지난 값만 미룸 저장소에 넘긴다. @throws EventRefundHoldError
   */
  async setHold(i: EventRefundHoldInput): Promise<EventRefundHoldState> {
    const parsed = parseEventRefundHold(i);
    if (!this.o.holds) throw new Error('환급 미룸 저장소가 조립되지 않았다');
    return this.o.holds.set(parsed);
  }

  async preview(i: EventRefundPreviewInput): Promise<EventRefundPreview> {
    const targets = await this.#targets(i.eventId);
    const preview = eventRefundPreviewOf(targets, i.fault);
    this.#rememberPreview(i.eventId, i.fault, preview.compensationOrders, this.o.nowMs());
    return preview;
  }

  #rememberPreview(eventId: string, fault: EventRefundFault, orders: readonly CompensationOrder[] | undefined, nowMs: number): void {
    const key = `${eventId}:${fault}`;
    // 같은 키를 다시 쓰면 차례를 뒤로 옮긴다(오래된 것부터 버린다)
    this.#previews.delete(key);
    this.#previews.set(key, { ...(orders === undefined ? {} : { orders }), atMs: nowMs });
    while (this.#previews.size > EVENT_REFUND_PREVIEW_CACHE) {
      const oldest = this.#previews.keys().next().value;
      if (oldest === undefined) break;
      this.#previews.delete(oldest);
    }
  }

  /** 미리보기 목록이 아직 신선하면 준다. 없거나 지났으면 undefined(옛 호출은 다시 계산한다) */
  #previewOrdersOf(eventId: string, fault: EventRefundFault, nowMs: number): { readonly orders?: readonly CompensationOrder[] } | undefined {
    const found = this.#previews.get(`${eventId}:${fault}`);
    if (found === undefined || nowMs - found.atMs > EVENT_REFUND_PREVIEW_TTL_MS) return undefined;
    return found;
  }

  async start(i: EventRefundStartInput): Promise<EventCancellationRequest> {
    if (!UUID.test(i.requestId)) throw new EventRefundError('INVALID', 'requestId가 UUID가 아닙니다');
    if (!UUID.test(i.eventId)) throw new EventRefundError('INVALID', 'eventId가 UUID가 아닙니다');
    if (i.ruledBy.length === 0 || i.confirmedBy.length === 0) throw new EventRefundError('INVALID', '판정자와 확정자가 필요합니다');
    if (i.ruledBy === i.confirmedBy) throw new EventRefundError('CONFLICT', '판정자와 확정자는 달라야 합니다');
    const kind: EventRefundKind = i.kind ?? 'CANCEL';
    const existing = await this.o.store.find(i.requestId);
    if (existing) {
      if (existing.eventId !== i.eventId || existing.fault !== i.fault || existing.kind !== kind) throw new EventRefundError('CONFLICT', '같은 요청 ID의 회차·판정·종류가 다릅니다');
      return this.get(i.requestId);
    }
    const nowMs = this.o.nowMs();
    const window = this.#windowOf(kind, i, nowMs);
    const listed = await this.#targets(i.eventId);
    // 연기(POSTPONE) 신청 환급은 예매 취소 Saga로 하므로 보류 취소(REQUESTED) 표를 넣지 않는다(그 표는 마감 뒤 환급으로 끝난다, GAT-110 E5)
    const targets = kind === 'POSTPONE' ? listed.filter((t) => t.pendingCancellationId === undefined) : listed;
    const preview = eventRefundPreviewOf(targets, i.fault);
    // 배상 금액은 미리보기(dry_run)에서 주문 단위로 계산한 값을 그대로 쓴다(B13, BAT-425 RV-02). 확정 때 표·주문이 바뀌어도 흔들리지 않는다.
    // 확정 요청이 목록을 싣지 않는 옛 호출은 같은 프로세스의 미리보기를 쓰고, 그것도 없으면 지금처럼 같은 함수로 다시 계산한다
    const savedPreview = i.compensationOrders === undefined ? this.#previewOrdersOf(i.eventId, i.fault, nowMs) : undefined;
    const compensationOrders = i.compensationOrders ?? savedPreview?.orders ?? preview.compensationOrders;
    const items: EventRefundItem[] = targets.map((t) => itemOf(i.requestId, t, kind, nowMs));
    // 배상 행(BAT-425, ADR-0317 결정 2): 회차 취소(CANCEL)이고 주최 측 귀책·공연 내용 변경일 때 대상 주문마다 한 행을 요청·항목과 같은 트랜잭션에 만든다.
    // 미리보기 목록이 있으면 그 금액을 쓰고, 불가항력·0원 주문은 행이 없다
    const compensationRows =
      kind === 'CANCEL' ? compensationRowsOf({ requestId: i.requestId, eventId: i.eventId, fault: i.fault, targets, ...(compensationOrders === undefined ? {} : { orders: compensationOrders }), nowMs, idOf: () => randomUUID() }) : [];
    // 요약 수·합계는 실제 배상 행에서 센다(RV-22). 미리보기 뒤 확정 대상에서 빠진 주문은 행과 함께 요약에서도 빠진다
    const compensationTargets = compensationRows.length;
    const compensationTotal = compensationRows.reduce((sum, row) => sum + row.amount, 0);
    const progress = progressOf(items, [], kind === 'POSTPONE');
    // 입력 검증·대상 읽기가 끝난 뒤에만 ticket-svc의 진행 중 양도 요청을 철회한다(IR-09).
    // 실패하면 아무것도 쓰지 않고 503(UNAVAILABLE)이다. 같은 요청 ID의 다시 부르기는 위에서 돌아가 한 번만 부른다
    if (kind === 'POSTPONE' && this.o.transfers) {
      try {
        await this.o.transfers.withdrawForEvent({ eventId: i.eventId, nowMs });
      } catch (err) {
        this.o.log?.warn({ event: 'transfer-withdraw-failed', eventId: i.eventId, err: err instanceof Error ? err.name : 'unknown' }, '연기 확정의 양도 요청 철회가 실패했다(503, SEV2 후보)');
        throw new EventRefundError('UNAVAILABLE', `양도 요청을 철회하지 못했습니다: ${err instanceof Error ? err.name : 'unknown'}`);
      }
    }
    const request: EventCancellationRequest = {
      requestId: i.requestId,
      eventId: i.eventId,
      kind,
      status: kind === 'POSTPONE' ? 'REFUND_WINDOW' : 'RUNNING',
      fault: i.fault,
      ...(i.fanNoticeReason !== undefined ? { fanNoticeReason: i.fanNoticeReason } : {}),
      ...(window ? { postponedToMs: window.postponedToMs, refundWindowClosesAtMs: window.refundWindowClosesAtMs } : {}),
      targetOrders: preview.targetOrders,
      refundTotal: preview.refundTotal,
      compensationTargets,
      compensationTotal,
      progress,
      ruledBy: i.ruledBy,
      confirmedBy: i.confirmedBy,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const confirmed = this.o.fanNotifier?.confirmed(request, targets, nowMs) ?? [];
    // 처음 만들 때만(다시 부르기는 위에서 돌아갔다) 남는 공제 차액 대상을 찾아 요청 행과 같은 트랜잭션에서 표시한다(BAT-420 몫 D, R-T38 ④, 웨이브 끝 리뷰 C2·S1)
    const gapRows = kind === 'CANCEL' ? await this.#findDeductionGaps(request) : [];
    let created: EventCancellationRequest;
    try {
      created = await this.o.store.create(request, items, confirmed, {
        ...(gapRows.length > 0 ? { deductionGaps: gapRows.map((r) => r.cancellationId) } : {}),
        ...(compensationRows.length > 0 ? { compensations: compensationRows } : {}),
      });
    } catch (err) {
      // 같은 회차의 진행 중 요청(0016 active key)과 부딪히면 500이 아니라 409다
      if (err instanceof EventRefundActiveConflict) throw new EventRefundError('CONFLICT', `같은 회차에 진행 중인 회차 취소 요청이 있습니다: ${err.requestId}`);
      throw err;
    }
    if (kind === 'CANCEL') {
      // 차액 건은 결제사 호출이 아니다. 다시 열기 포트(csOutbox)가 있으면 일괄 환불 실행기 틱이 행마다 열고, 없으면(옛 조립) 여기서 행마다 따로 연다
      if (!this.o.csOutbox) for (const row of gapRows) await this.#openGapNow(request.requestId, row, nowMs);
      // 발권 대기(APPROVED) 주문의 보상 세 걸음을 큐에 넣는다(BAT-011, PRF-173). 보상이 끝날 때까지 요청은 RUNNING이다
      await this.#queueCompensation(created);
      // 정산 보류 열기는 요청을 커밋한 뒤 처리 전에 한 번 부른다(ADR-0380 결정 1). 실패는 확정·환급을 막지 않는다
      await this.#settlementNotice(created, 'hold-only');
      await this.#run(created, targets, this.o.firstBatch ?? 200);
    }
    // 연기는 보류 열기만, 취소는 처리 뒤 COMPLETED면 완료도 같은 자리에서 알린다
    await this.#settlementNotice(await this.get(i.requestId));
    return this.get(i.requestId);
  }

  /**
   * 정산 다시 계산 알리기 한 걸음(ADR-0380 결정 1~3). 보류 열기를 아직 받지 않았으면 열고, 열었고 요청이 COMPLETED(또는 확정 + 3영업일 [가정])면 완료를 한 번 알린다.
   * 다시 부를 시각 전이면 아무것도 하지 않는다. 실패는 던지지 않고 다시 부를 시각(1분 → 5분 → 15분, 그 뒤 15분마다 [가정])과 경고(요청 ID만)를 남긴다
   */
  async #settlementNotice(request: EventCancellationRequest, mode: 'full' | 'hold-only' = 'full'): Promise<void> {
    const port = this.o.settlement;
    if (!port || request.status === 'REJECTED') return;
    const nowMs = this.o.nowMs();
    let state: EventRefundSettlementNotice = (await this.o.store.settlementNotice?.(request.requestId)) ?? { failures: 0 };
    if (state.completionSentAtMs !== undefined) return;
    if (state.nextAtMs !== undefined && state.nextAtMs > nowMs) return;
    if (state.holdSentAtMs === undefined) {
      try {
        await port.open({ requestId: request.requestId, eventId: request.eventId, kind: request.kind, confirmedAt: new Date(request.createdAtMs) });
      } catch (err) {
        await this.#settlementNoticeFailed(request.requestId, state, 'open', err, nowMs);
        return;
      }
      state = { holdSentAtMs: nowMs, failures: 0 };
      await this.o.store.markSettlementNotice?.(request.requestId, state);
    }
    if (mode === 'hold-only') return;
    const completed = request.status === 'COMPLETED';
    const partial = !completed && nowMs >= addKstWeekdays(request.createdAtMs, SETTLEMENT_PARTIAL_BUSINESS_DAYS);
    if (!completed && !partial) return;
    try {
      await port.complete(request.requestId, { completedAt: new Date(nowMs), partial });
    } catch (err) {
      await this.#settlementNoticeFailed(request.requestId, state, 'complete', err, nowMs);
      return;
    }
    await this.o.store.markSettlementNotice?.(request.requestId, { ...(state.holdSentAtMs !== undefined ? { holdSentAtMs: state.holdSentAtMs } : {}), completionSentAtMs: nowMs, failures: 0 });
    if (partial) {
      this.o.log?.warn(
        { event: 'event-refund-settlement-partial', requestId: request.requestId },
        'event-refund-settlement-partial: 확정 뒤 3영업일이 지나도 일괄 환불이 끝나지 않아 그때까지의 환급으로 정산 완료를 알렸다(남은 환급은 계산 뒤 환급 미수금이 된다)',
      );
    }
  }

  async #settlementNoticeFailed(requestId: string, state: EventRefundSettlementNotice, stage: 'open' | 'complete', err: unknown, nowMs: number): Promise<void> {
    const failures = state.failures + 1;
    const gap = SETTLEMENT_NOTICE_RETRY_MS[Math.min(failures, SETTLEMENT_NOTICE_RETRY_MS.length) - 1]!;
    // 회차 ID·주소·원래 오류 글은 싣지 않는다(요청 ID와 단계, 오류 이름만)
    this.o.log?.warn(
      { event: 'event-refund-settlement-notice-failed', requestId, stage, err: err instanceof Error ? err.name : 'unknown' },
      'event-refund-settlement-notice-failed: 정산 알리기를 payment-svc가 받지 않아 실행기 틱이 다시 부른다(환급은 계속한다)',
    );
    try {
      await this.o.store.markSettlementNotice?.(requestId, { ...state, nextAtMs: nowMs + gap, failures });
    } catch (markErr) {
      this.o.log?.warn({ event: 'event-refund-settlement-notice-failed', requestId, stage: 'mark', err: markErr instanceof Error ? markErr.name : 'unknown' }, 'event-refund-settlement-notice-failed: 다시 부를 시각을 쓰지 못했다');
    }
  }

  /** 틱 끝의 정산 알리기 다시 하기. 한 요청의 실패가 다른 요청을 막지 않는다 */
  async #settlementNotices(): Promise<void> {
    const store = this.o.store;
    if (!this.o.settlement || !store.settlementNoticesDue) return;
    let rows: readonly EventCancellationRequest[];
    try {
      rows = await store.settlementNoticesDue(this.o.nowMs(), SETTLEMENT_NOTICE_BATCH);
    } catch (err) {
      this.o.log?.warn({ event: 'event-refund-settlement-notice-failed', stage: 'list', err: err instanceof Error ? err.name : 'unknown' }, 'event-refund-settlement-notice-failed: 다시 알릴 요청을 읽지 못했다');
      return;
    }
    for (const request of rows) {
      try {
        await this.#settlementNotice(request);
      } catch (err) {
        this.o.log?.warn({ event: 'event-refund-settlement-notice-failed', requestId: request.requestId, stage: 'tick', err: err instanceof Error ? err.name : 'unknown' }, 'event-refund-settlement-notice-failed');
      }
    }
  }

  /** 틱 끝의 배상 송금 결과 확정(R-T47 ③). 실패는 그 틱의 환급 결과를 바꾸지 않고 경고만 남긴다 */
  async #refreshCompensations(): Promise<void> {
    const refresh = this.o.compensationRefresh;
    if (!refresh) return;
    try {
      await refresh.run(COMPENSATION_REFRESH_LIMIT);
    } catch (err) {
      this.o.log?.warn({ event: 'compensation-transfer-refresh-failed', err: err instanceof Error ? err.name : 'unknown' }, 'compensation-transfer-refresh-failed: 배상 송금 결과를 확정하지 못했다(다음 틱에 다시 본다)');
    }
  }

  /**
   * 회차 취소 확정 때 남는 공제 차액 대상(BAT-420 몫 D, OPEN[45] 결정 ②, transfer-refund §5). 입장 시작 시각은 회차 판매 설정에서 읽는다(대상 표가 0이어도 찾는다, 보충 2).
   * 설정에 입장 시작이 없으면 찾지 않고 경고를 남긴다. best effort: 찾기가 실패하면 경고 뒤 빈 목록이고 일괄 환불은 이어 간다
   */
  async #findDeductionGaps(request: EventCancellationRequest): Promise<readonly { cancellationId: string; orderId: string; deductionAmount: number }[]> {
    const { gaps, gapNotice } = this.o;
    if (!gaps || !gapNotice) return [];
    try {
      const entryOpensAtMs = await this.#entryOpensAt(request.eventId);
      if (entryOpensAtMs === undefined) {
        this.o.log?.warn({ eventId: request.eventId, requestId: request.requestId }, 'event-refund-deduction-gap-skipped: 회차 판매 설정에 입장 시작 시각이 없어 차액 건을 찾지 않는다');
        return [];
      }
      return await gaps.list(request.eventId, entryOpensAtMs);
    } catch (err) {
      this.o.log?.warn({ eventId: request.eventId, requestId: request.requestId, err: err instanceof Error ? err.message : 'unknown' }, 'event-refund-deduction-gap-failed');
      return [];
    }
  }

  /**
   * 차액 건 하나를 지금 연다(다시 열기 포트가 없는 옛 조립). 한 행이 실패해도 나머지는 이어 열고, 실패는 경고·지표만 남긴다(항목 상태를 바꾸지 않는다, 웨이브 끝 리뷰 C2)
   */
  async #openGapNow(requestId: string, row: { cancellationId: string; orderId: string; deductionAmount: number }, nowMs: number): Promise<void> {
    if (!this.o.gapNotice) return;
    try {
      await this.o.gapNotice.open({ cancellationId: row.cancellationId, orderId: row.orderId, deductionAmount: row.deductionAmount, requestId, nowMs });
    } catch (err) {
      this.#gapOpenFailed(requestId, row.cancellationId, err);
    }
  }

  #gapOpenFailed(requestId: string, cancellationId: string, err: unknown): void {
    this.o.log?.warn({ event: 'event-refund-deduction-gap-failed', requestId, cancellationId, err: err instanceof Error ? err.name : 'unknown' }, 'event-refund-deduction-gap-failed: 차액 CS 건을 열지 못했다(다음 틱에 다시 연다)');
    this.o.csCaseOpenFailures?.inc('DEDUCTION_GAP');
  }

  /**
   * 틱 끝 한 곳의 CS 건 다시 열기(다시 보기 2 N1·N2, transfer-refund §3.1 ⑥). 열지 않은 일괄 환불 실패 건(failure_case_at 있음·failure_case_opened_at 빔) →
   * 차액 건(deduction_gap_at 있음·deduction_gap_opened_at 빔) 차례로 종류마다 100건 [가정]까지, 한 틱 예산 하나(5초 [가정])와 잇따른 무응답 멈춤(2번 [가정]) 안에서
   * 행마다 따로 연다. ops-svc가 2xx로 받은 행만 연 시각을 쓴다. 한 행이 실패해도 나머지는 열고, 실패한 행은 경고·지표 뒤 다음 틱에 다시 연다. 던지지 않는다
   */
  async #reopenCases(): Promise<void> {
    const { csOutbox, notice, gapNotice } = this.o;
    if (!csOutbox) return;
    const tick = new CsCaseReopenTick({ nowMs: () => this.o.nowMs(), runner: 'event-refund', signals: this.o.csCaseOpenFailures, log: this.o.log });
    if (notice) {
      await tick.reopen({
        kind: 'EVENT_REFUND_FAILED',
        failedEvent: 'event-refund-failure-notice-failed',
        list: (limit) => csOutbox.pendingItemFailures(limit),
        open: (row, nowMs) => notice.open({ ...row, nowMs }),
        markOpened: (row, nowMs) => csOutbox.markItemFailureOpened(row.requestId, row.ticketId, nowMs),
        ids: (row) => ({ requestId: row.requestId, cancellationId: row.cancellationId }),
      });
    }
    if (gapNotice) {
      await tick.reopen({
        kind: 'DEDUCTION_GAP',
        failedEvent: 'event-refund-deduction-gap-failed',
        list: (limit) => csOutbox.pendingGaps(limit),
        open: (row, nowMs) => gapNotice.open({ cancellationId: row.cancellationId, orderId: row.orderId, deductionAmount: row.deductionAmount, requestId: row.requestId, nowMs }),
        markOpened: (row, nowMs) => csOutbox.markGapOpened(row.cancellationId, nowMs),
        ids: (row) => ({ requestId: row.requestId, cancellationId: row.cancellationId }),
      });
    }
  }

  async #entryOpensAt(eventId: string): Promise<number | undefined> {
    if (!this.o.configs) return undefined;
    return (await this.o.configs.config(eventId))?.entryOpensAtMs;
  }

  /**
   * 확정 뒤 그 표를 처리하기 전에 팬 취소가 끼어들어 표를 끝낸 항목(ticket-already-ended·cancellation-conflict)이면, 그 표의 결제사로 보낸 USER 취소 가운데
   * 공제 > 0인 것을 준다(BAT-420 리뷰 D5, transfer-refund §5 '확정 뒤 팬 취소'). 그 밖·찾기 실패는 undefined(일반 실패 알림)
   */
  async #overlapGapOf(request: EventCancellationRequest, item: EventRefundItem, error: string): Promise<{ cancellationId: string; orderId: string; deductionAmount: number } | undefined> {
    if (error !== 'ticket-already-ended' && error !== 'cancellation-conflict') return undefined;
    const forTicket = this.o.gaps?.forTicket?.bind(this.o.gaps);
    if (!forTicket || !this.o.gapNotice) return undefined;
    try {
      const fan = await forTicket(item.ticketId);
      if (!fan || fan.cancellationId === item.cancellationId || !(fan.deductionAmount > 0)) return undefined;
      return fan;
    } catch (err) {
      this.o.log?.warn({ eventId: request.eventId, requestId: request.requestId, err: err instanceof Error ? err.message : 'unknown' }, 'event-refund-deduction-gap-failed');
      return undefined;
    }
  }

  /** 전환에서 진 항목(cancellation-in-progress)의 그 보류 취소가 차액 대상이면 그 행을 준다(BAT-420 몫 D, GAT-110 D7). 못 찾거나 실패하면 undefined */
  async #gapOf(request: EventCancellationRequest, item: EventRefundItem): Promise<{ cancellationId: string; orderId: string; deductionAmount: number } | undefined> {
    if (!this.o.gaps || !this.o.gapNotice) return undefined;
    try {
      const entryOpensAtMs = await this.#entryOpensAt(request.eventId);
      if (entryOpensAtMs === undefined) return undefined;
      return (await this.o.gaps.list(request.eventId, entryOpensAtMs)).find((r) => r.cancellationId === item.cancellationId);
    } catch (err) {
      this.o.log?.warn({ eventId: request.eventId, requestId: request.requestId, err: err instanceof Error ? err.message : 'unknown' }, 'event-refund-deduction-gap-failed');
      return undefined;
    }
  }

  async get(requestId: string): Promise<EventCancellationRequest> {
    if (!UUID.test(requestId)) throw new EventRefundError('INVALID', 'requestId가 UUID가 아닙니다');
    const request = await this.o.store.find(requestId);
    if (!request) throw new EventRefundError('NOT_FOUND', '회차 취소 요청을 찾을 수 없습니다');
    const items = await this.o.store.items(requestId);
    const paused = pausedOf(request);
    return { ...request, progress: progressOf(items, paused, this.#windowOpen(request)) };
  }

  async pause(i: EventRefundPauseInput): Promise<EventCancellationRequest> {
    const request = await this.get(i.requestId);
    if (request.status === 'COMPLETED' || request.status === 'REJECTED') throw new EventRefundError('CONFLICT', '끝난 작업은 멈출 수 없습니다');
    const reason = i.reason.trim();
    if (reason.length === 0) throw new EventRefundError('INVALID', '멈추는 사유가 필요합니다');
    const items = await this.o.store.items(i.requestId);
    const nowMs = this.o.nowMs();
    // 잠근 DB 값의 멈춤에 MANUAL을 더한다(그사이 다른 실행이 적은 자동 정지를 지우지 않는다, W9-fix1 N8). 결제사를 안 주면 잠근 값의 모든 결제사 몫이다
    const written = await this.o.store.updateLocked(i.requestId, (current) => {
      if (ended(current)) return undefined;
      const pgs = i.pg ? [i.pg] : [...new Set([...items.map((x) => x.pg), ...(current.progress.perPg ?? []).map((p) => p.pg)])];
      const paused = mergePauses(pausedOf(current), { add: pgs.map((pg) => ({ pg, reason: 'MANUAL' as const })) });
      return { ...current, status: 'PAUSED', progress: progressOf(items, paused, false), updatedAtMs: nowMs };
    });
    if (!written) throw new EventRefundError('CONFLICT', '끝난 작업은 멈출 수 없습니다');
    return this.get(i.requestId);
  }

  async resume(i: EventRefundResumeInput): Promise<EventCancellationRequest> {
    const request = await this.get(i.requestId);
    if (request.status === 'COMPLETED' || request.status === 'REJECTED') throw new EventRefundError('CONFLICT', '끝난 작업은 다시 시작할 수 없습니다');
    // 빼는 것은 그 결제사만, 한꺼번에면 재개가 처음 읽은 멈춤만이다(읽은 뒤 생긴 자동 정지는 남는다, W9-fix1 N8)
    const lift = i.pg ? [i.pg] : pausedOf(request).map((p) => p.pg);
    const items = await this.o.store.items(i.requestId);
    // 수동 재개는 기다리던 재시도를 지금 다시 본다(결과 모름을 결제사 조회로 먼저 끝내는 규칙).
    const nowMs = this.o.nowMs();
    for (const item of items) {
      if ((item.status === 'UNKNOWN' || item.status === 'PENDING') && item.appliedAtMs !== undefined && (!i.pg || item.pg === i.pg) && (item.nextAttemptAtMs ?? 0) > nowMs) {
        await this.o.store.updateItem({ ...item, nextAttemptAtMs: nowMs });
      }
    }
    // 상태는 실행 중으로 두고, 남은 멈춤이 있으면 이어 도는 실행이 끝에서 다시 정한다
    const running = await this.o.store.updateLocked(i.requestId, (current) => {
      if (ended(current)) return undefined;
      const windowOpen = this.#windowOpen(current);
      const paused = mergePauses(pausedOf(current), { lift });
      return { ...current, status: windowOpen ? 'REFUND_WINDOW' : 'RUNNING', progress: progressOf(items, paused, windowOpen), updatedAtMs: nowMs };
    });
    if (!running) throw new EventRefundError('CONFLICT', '끝난 작업은 다시 시작할 수 없습니다');
    const targets = await this.#targets(request.eventId);
    await this.#run(running, targets, this.o.firstBatch ?? 200);
    return this.get(i.requestId);
  }

  /** 연기(POSTPONE)에서 팬이 환급을 신청한다. 같은 요청·티켓은 한 번만 신청된다 */
  async apply(i: EventRefundApplyInput): Promise<EventCancellationRequest> {
    const request = await this.get(i.requestId);
    if (request.kind !== 'POSTPONE') throw new EventRefundError('CONFLICT', '연기 요청만 환급을 신청할 수 있습니다');
    if (!this.#windowOpen(request)) throw new EventRefundError('CONFLICT', '환급 신청 창이 닫혔습니다');
    if (!UUID.test(i.ticketId)) throw new EventRefundError('INVALID', 'ticketId가 UUID가 아닙니다');
    const item = (await this.o.store.items(i.requestId)).find((x) => x.ticketId === i.ticketId);
    if (!item) throw new EventRefundError('NOT_FOUND', '그 요청의 대상 티켓이 아닙니다');
    if (item.appliedAtMs === undefined) {
      const nowMs = i.appliedAtMs ?? this.o.nowMs();
      const accepted = await this.o.store.markApplied(i.requestId, i.ticketId, nowMs);
      if (!accepted) {
        const again = (await this.o.store.items(i.requestId)).find((x) => x.ticketId === i.ticketId);
        if (again?.appliedAtMs === undefined) throw new EventRefundError('CONFLICT', '환급 신청 창이 닫혔습니다');
      }
    }
    const targets = await this.#targets(request.eventId);
    await this.#run(await this.get(i.requestId), targets, this.o.firstBatch ?? 200);
    return this.get(i.requestId);
  }

  /** 신청 창을 지금 닫는다. 신청하지 않은 티켓은 NOT_APPLIED로 끝나고 환급하지 않는다 */
  async closeWindow(i: EventRefundCloseWindowInput): Promise<EventCancellationRequest> {
    const request = await this.get(i.requestId);
    if (request.kind !== 'POSTPONE') throw new EventRefundError('CONFLICT', '연기 요청만 신청 창을 닫을 수 있습니다');
    if (!this.#windowOpen(request)) return this.get(i.requestId);
    const reason = i.reason.trim();
    if (reason.length === 0) throw new EventRefundError('INVALID', '창을 닫는 사유가 필요합니다');
    await this.#closeWindowNow(request, i.closedBy);
    const targets = await this.#targets(request.eventId);
    await this.#run(await this.get(i.requestId), targets, this.o.firstBatch ?? 200);
    return this.get(i.requestId);
  }

  /**
   * 백그라운드 실행기 한 바퀴: 닫을 창을 닫고, 실행 중 요청의 due 항목을 조금씩 처리한다.
   * 회차 취소(CANCEL)는 실행 중·멈춤 요청마다 대상을 다시 골라 항목이 없는 표를 더하고(확정 뒤 결제가 끝난 주문, ADR-0280 결정 4),
   * 실행 중이면 할 항목이 없어도 완료 여부를 다시 본다(끝나지 않은 주문이 남으면 RUNNING, 결정 5). 멈춘 요청은 더하기만 하고 부르지 않는다.
   * CS 건은 그 틱의 창 닫기·쓸어 담기·항목 처리가 끝난 뒤(처리가 던져도) 틱 끝에서만 연다(다시 보기 2 N1). 열기 실패는 항목 상태를 바꾸지 않고 틱도 멈추지 않는다
   */
  async runDue(): Promise<{ closedWindows: number; processed: number }> {
    try {
      return await this.#runDueRefunds();
    } finally {
      await this.#reopenCases();
      await this.#settlementNotices();
      await this.#refreshCompensations();
    }
  }

  async #runDueRefunds(): Promise<{ closedWindows: number; processed: number }> {
    const nowMs = this.o.nowMs();
    let closedWindows = 0;
    for (const request of await this.o.store.dueWindowClosures(nowMs, 20)) {
      await this.#closeWindowNow(request, 'system:event-refund-window');
      closedWindows++;
    }
    let processed = 0;
    for (const request of await this.o.store.activeRequests(20)) {
      if (request.status === 'COMPLETED' || request.status === 'REJECTED') continue;
      const sweeping = request.kind === 'CANCEL' && this.o.items !== undefined && this.o.openOrders !== undefined;
      let targets: readonly EventRefundTarget[] | undefined;
      if (sweeping && (request.status === 'RUNNING' || request.status === 'PAUSED')) {
        targets = await this.#targets(request.eventId);
        await this.#sweep(request, targets);
      }
      // 발권 대기(APPROVED) 주문의 보상은 멈춘 요청에서도 큐에 넣는다(발권을 멈추고 결제를 취소해야 요청이 끝난다, BAT-011)
      if (request.kind === 'CANCEL' && (request.status === 'RUNNING' || request.status === 'PAUSED')) await this.#queueCompensation(request);
      if (request.status === 'PAUSED') continue;
      const items = await this.o.store.dueItems(request.requestId, nowMs, this.o.batchSize ?? 200);
      if (items.length === 0 && !sweeping) continue;
      targets ??= await this.#targets(request.eventId);
      await this.#run(request, targets, items.length);
      processed += items.length;
    }
    return { closedWindows, processed };
  }

  /**
   * 회차 취소 확정 뒤 발권 대기(APPROVED) 주문을 보상 세 걸음 큐에 넣는다(BAT-011, PRF-173, ADR-0354 결정 3).
   * 큐가 없으면(옛 조립) 아무것도 하지 않는다. 실패는 요청 상태를 바꾸지 않고 경고만 남긴다(다음 틱이 다시 넣는다)
   */
  async #queueCompensation(request: EventCancellationRequest): Promise<void> {
    const queue = this.o.compensation;
    if (!queue) return;
    try {
      const created = await queue.queue(request.eventId);
      if (created > 0) this.o.log?.info?.({ event: 'event-compensation-queued', requestId: request.requestId, created }, '회차 취소 확정 뒤 발권 대기 주문을 보상 큐에 넣었다');
    } catch (err) {
      this.o.log?.warn({ event: 'event-compensation-queue-failed', requestId: request.requestId, eventId: request.eventId, err: err instanceof Error ? err.name : 'unknown' }, 'event-compensation-queue-failed: 보상 큐에 넣지 못했다(다음 틱에 다시 넣는다)');
    }
  }

  /** 대상을 다시 골라 그 요청에 항목이 없는 표를 PENDING으로 더하고, 새 주문마다 확정 알림을 한 번 남긴다(같은 트랜잭션) */
  async #sweep(request: EventCancellationRequest, targets: readonly EventRefundTarget[]): Promise<void> {
    const existing = await this.o.store.items(request.requestId);
    const tickets = new Set(existing.map((i) => i.ticketId));
    const fresh = targets.filter((t) => !tickets.has(t.ticketId));
    if (fresh.length === 0 || !this.o.items) return;
    const nowMs = this.o.nowMs();
    const knownOrders = new Set(existing.map((i) => i.orderId));
    const newOrderTargets = fresh.filter((t) => !knownOrders.has(t.orderId));
    const outbox = newOrderTargets.length > 0 ? (this.o.fanNotifier?.confirmed(request, newOrderTargets, nowMs) ?? []) : [];
    // 확정 뒤에 결제가 끝난 새 주문의 배상 행(F-07-8 RV-18, R-T46 ④): 확정 때와 같은 함수로 주문마다 한 행을 항목과 같은 트랜잭션에. 불가항력·0원 주문은 0행이고 아는 주문은 고치지 않는다
    const compensations =
      request.fault !== undefined && newOrderTargets.length > 0
        ? compensationRowsOf({ requestId: request.requestId, eventId: request.eventId, fault: request.fault, targets: newOrderTargets, nowMs, idOf: () => randomUUID() })
        : [];
    await this.o.items.addItems(
      request.requestId,
      fresh.map((t) => itemOf(request.requestId, t, 'CANCEL', nowMs)),
      outbox,
      ...(compensations.length > 0 ? [{ compensations }] : []),
    );
  }

  async #closeWindowNow(request: EventCancellationRequest, closedBy: string): Promise<void> {
    const nowMs = this.o.nowMs();
    const items = await this.o.store.items(request.requestId);
    for (const item of items) {
      // 신청과 창 닫기가 겹치면 행 잠금이 먼저 온 쪽만 남긴다. 신청이 이겼으면 applied_at이 있어 여기서 지우지 않는다.
      if (item.appliedAtMs === undefined) await this.o.store.markNotApplied(request.requestId, item.ticketId);
    }
    const after = await this.o.store.items(request.requestId);
    let progress = progressOf(after, pausedOf(request), false);
    // 잠근 DB 값의 멈춤을 그대로 쓰고, 그사이 PAUSED가 됐으면 상태를 둔다(창을 읽은 뒤 적힌 자동 정지를 지우지 않는다, W9-fix1 N8)
    await this.o.store.updateLocked(request.requestId, (current) => {
      if (ended(current)) return undefined;
      const paused = pausedOf(current);
      progress = progressOf(after, paused, false);
      const status = current.status === 'PAUSED' ? 'PAUSED' : statusAfterRun(current, progress, paused, false);
      return { ...current, status, progress, updatedAtMs: nowMs };
    });
    await this.o.alert?.raise({
      requestId: request.requestId,
      eventId: request.eventId,
      severity: 'SEV3',
      reason: 'REFUND_WINDOW_CLOSED',
      detail: { closedBy, notApplied: progress.notApplied, total: progress.total },
      nowMs,
    });
  }

  async #run(request: EventCancellationRequest, targets: readonly EventRefundTarget[], limit: number): Promise<void> {
    const paused = new Map(pausedOf(request).map((p) => [p.pg, p.reason]));
    const byTicket = new Map(targets.map((t) => [t.ticketId, t]));
    const nowMs = this.o.nowMs();
    const all = await this.o.store.items(request.requestId);
    // 같은 주문의 앞 표가 재시도를 기다리면(결과 모름, 다음 시도 시각 전) 그 주문의 나머지 표는 이번 실행에 넣지 않는다(리뷰 B4).
    // 넣지 않은 표는 부르지도 시도로 기록하지도 않아 자동 정지의 실패율·연속 실패·실패 금액에 들지 않는다
    const waitingOrders = new Set(all.filter((i) => i.status === 'UNKNOWN' && i.nextAttemptAtMs !== undefined && i.nextAttemptAtMs > nowMs).map((i) => i.orderId));
    const queue = all
      .filter(
        (i) =>
          (i.status === 'PENDING' || i.status === 'UNKNOWN') &&
          i.appliedAtMs !== undefined &&
          (i.nextAttemptAtMs === undefined || i.nextAttemptAtMs <= nowMs) &&
          !paused.has(i.pg) &&
          !waitingOrders.has(i.orderId),
      )
      .slice(0, Math.max(0, limit));
    // 같은 주문의 표는 한 작업자가 큐 차례대로 처리한다. payment-svc가 같은 결제의 일반 취소를 한 번에 하나씩 보내므로(10분 안의 진행 중 건이 있으면 결과 모름),
    // 같은 주문의 표를 동시에 보내면 결과 모름이 자동 정지 실패율에 섞인다(docs/data.md §5 '같은 주문의 표 둘을 동시에 취소', BUILD_ORDER GAT-080).
    // 묶음 안에서는 재시도할 결과 모름을 처음 보내는 표보다 먼저 한다(앞 건이 끝나야 뒤 건을 보낼 수 있다)
    const groups = groupByOrder(queue);
    const newlyPaused: { pg: RefundPgProvider; reason: RefundPauseReason; detail: Record<string, unknown> }[] = [];
    /**
     * 항목 하나를 처리하고, 그 항목이 끝났는지(환급·실패) 돌려준다. 멈춤·자동 정지로 보내지 않았거나 재시도를 기다리거나 잡기를 잃었으면 false다.
     * claim이 있으면 쓰기는 잡기 값을 조건으로 한 끝내기(claims.finish)다(웨이브 끝 리뷰 K2). 시도 기록·CS 건·차액 건은 쓰기가 된 뒤에만 남긴다.
     * 표를 결제사로 보내기 직전에 남은 잡기 기한이 짧으면 늘리고, 늘리지 못하면 보내지 않는다(W9-fix1 N3)
     */
    const processItem = async (item: EventRefundItem, claim?: HeldClaim): Promise<boolean> => {
      const claimToken = claim?.token;
      // 실행 중에 사람이 멈췄을 수 있다. 항목마다 저장된 상태를 다시 보고 새 호출을 보내지 않는다
      const current = await this.o.store.find(request.requestId);
      if (current) {
        for (const p of pausedOf(current)) paused.set(p.pg, p.reason);
        if (current.status === 'PAUSED' && !paused.has(item.pg)) paused.set(item.pg, 'MANUAL');
      }
      if (paused.has(item.pg)) return false;
      // 기준을 넘긴 뒤 새 호출을 한 건도 더 보내지 않게 항목마다 판정한다
      const stop = await this.#stopReason(item.pg, nowMs);
      if (stop) {
        const pgs = stop.all ? request.progress.perPg.map((p) => p.pg) : [item.pg];
        for (const pg of pgs) {
          if (!paused.has(pg)) {
            paused.set(pg, stop.reason);
            newlyPaused.push({ pg, reason: stop.reason, detail: stop.detail });
          }
        }
        return false;
      }
      const target = byTicket.get(item.ticketId);
      if (!target) return this.#finishItem(request, item, 'FAILED', 'target-not-found', undefined, { claimToken });
      // 결제사별 토큰 버킷(R-T52): 보내기 직전에 그 결제사 몫의 토큰을 기다린다. 기다림은 시도 기록·자동 정지에 들지 않는다.
      // 기다린 뒤 멈춤을 다시 보고(멈췄으면 보내지 않는다), 잡기 늘리기는 기다림 뒤에 본다
      if (this.o.buckets) {
        await this.o.buckets.take(item.pg);
        const after = await this.o.store.find(request.requestId);
        if (after) {
          for (const p of pausedOf(after)) paused.set(p.pg, p.reason);
          if (after.status === 'PAUSED' && !paused.has(item.pg)) paused.set(item.pg, 'MANUAL');
        }
        if (paused.has(item.pg)) return false;
      }
      if (claim && !(await this.#keepClaim(request, item, claim))) return false;
      let result: Awaited<ReturnType<EventRefundServiceDeps['canceller']['cancel']>>;
      try {
        result = await this.o.canceller.cancel(target, {
          requestId: request.requestId,
          eventId: request.eventId,
          cancellationId: item.cancellationId,
          reason: request.kind === 'POSTPONE' ? 'EVENT_POSTPONED' : 'EVENT_CANCELLED',
          nowMs: this.o.nowMs(),
          deadlineMs: this.o.deadlineMs(),
        });
      } catch (err) {
        // 취소기가 던지면 결과 모름이다. 항목 쓰기의 실패는 여기서 잡지 않는다(끝난 항목을 결과 모름으로 되돌리지 않는다, 웨이브 끝 리뷰 C2)
        const message = err instanceof Error ? err.message : 'unknown';
        const after = await this.#retryOrFail(request, item, 'UNKNOWN', message, target, claimToken);
        if (after !== 'LOST') await this.#recordAttempt(request, item, target, 'UNKNOWN');
        return after === 'FAILED';
      }
      // 결제사로 보내지 않은 실패(티켓 단계)는 결제사 호출로 세지 않고 재시도한다(GAT-110 E7)
      if (result.status === 'NOT_SENT') return (await this.#retryOrFail(request, item, 'UNKNOWN', result.error, target, claimToken)) === 'FAILED';
      // 결제사로 보내기 전에 끝난 즉시 실패는 기록하지 않고 바로 FAILED다(GAT-110 E1·E2)
      if (result.status === 'FAILED' && result.error !== undefined && IMMEDIATE_FAILURES.has(result.error)) {
        // 전환에서 진 항목: 마감 뒤 환급이 먼저 공제하고 보냈으면 일반 실패 알림 대신 그 행 공제액의 차액 건 하나만 연다(BAT-420 몫 D, GAT-110 D7).
        // 확정과 겹쳐 팬 취소가 먼저 그 표를 끝냈으면(ticket-already-ended·cancellation-conflict) 그 표의 공제 > 0인 USER 취소로 차액 건을 연다(BAT-420 리뷰 D5).
        // 차액 대상이 아니면(입장 시작 전 접수·공제 0·아직 보내지 않음) 전과 같이 일반 실패 알림이다.
        // 차액 대상 표시는 항목을 끝내는 같은 트랜잭션이고, 건은 다시 열기 포트가 있으면 실행기 틱이, 없으면 여기서 연다(웨이브 끝 리뷰 C2·S1)
        const gap = result.error === 'cancellation-in-progress' ? await this.#gapOf(request, item) : await this.#overlapGapOf(request, item, result.error);
        const finished = await this.#finishItem(request, item, 'FAILED', result.error, target, {
          claimToken,
          failureNotice: gap === undefined,
          ...(gap ? { deductionGap: { cancellationId: gap.cancellationId, requestId: request.requestId } } : {}),
        });
        if (finished && gap && !this.o.csOutbox) await this.#openGapNow(request.requestId, gap, this.o.nowMs());
        return finished;
      }
      // 계좌 대기(BUILD_ORDER GAT-090, R-T40): 결제사로 돈이 나가지 않았다. 항목을 ACCOUNT_PENDING으로 끝내 다시 보내지 않고, 같은 트랜잭션에서 그 취소 행에
      // 계좌 대기 표시를 쓴다. 자동 정지 기록(시도)에 넣지 않고(실패율·연속 실패·실패 금액 밖) 실패 알림·일괄 환불 실패 건도 열지 않는다.
      // CS '환불 대기' 건은 마감 뒤 환급 실행기의 틱 끝 다시 열기가 연다
      if (result.status === 'ACCOUNT_PENDING') return this.#finishItem(request, item, 'ACCOUNT_PENDING', 'refund-account-required', target, { claimToken });
      const outcome = outcomeOf(result.status, result.error);
      if (result.status === 'REFUNDED') {
        const finished = await this.#finishItem(request, item, 'REFUNDED', undefined, target, { claimToken });
        if (finished) await this.#recordAttempt(request, item, target, outcome);
        return finished;
      }
      if (result.status === 'REFUND_PENDING') {
        const after = await this.#retryOrFail(request, item, 'UNKNOWN', result.error ?? 'refund-pending', target, claimToken);
        if (after !== 'LOST') await this.#recordAttempt(request, item, target, outcome);
        return after === 'FAILED';
      }
      if (result.error !== undefined && FAILURE_ERRORS.has(result.error)) {
        const finished = await this.#finishItem(request, item, 'FAILED', result.error, target, { claimToken });
        if (finished) await this.#recordAttempt(request, item, target, outcome);
        return finished;
      }
      const after = await this.#retryOrFail(request, item, 'FAILED', result.error ?? 'failed', target, claimToken);
      if (after !== 'LOST') await this.#recordAttempt(request, item, target, outcome);
      return after === 'FAILED';
    };
    /** 같은 주문의 표를 차례로: 재시도할 결과 모름을 처음 보내는 표보다 먼저 하고, 앞 항목이 끝나지 않으면(결과 모름·멈춤·잡기 잃음) 나머지는 이번 실행에서 부르지 않는다(리뷰 B4) */
    const runGroup = async (group: readonly EventRefundItem[], claim?: HeldClaim): Promise<void> => {
      for (const item of [...group.filter((i) => i.status === 'UNKNOWN'), ...group.filter((i) => i.status !== 'UNKNOWN')]) if (!(await processItem(item, claim))) break;
    };
    const workers = Math.max(1, Math.min(this.o.concurrency ?? 8, groups.size || 1));
    const claims = this.o.claims;
    let settled: PromiseSettledResult<void>[];
    if (!claims) {
      const orderQueue = [...groups.values()];
      const worker = async (): Promise<void> => {
        for (;;) {
          const group = orderQueue.shift();
          if (!group) return;
          await runGroup(group);
        }
      };
      settled = await Promise.allSettled(Array.from({ length: workers }, worker));
    } else {
      // 프로세스 사이의 겹침 막기(웨이브 끝 리뷰 K2): 작업자마다 주문 하나씩 잡은 뒤 처리한다. 잡은 쪽만 처리하고 같은 주문의 표는 그 작업자가 차례로 한다.
      // 이번 실행이 잡는 주문 수는 위에서 본 처리할 주문 수(limit 안)까지다. 다른 쪽이 먼저 잡았으면 빈 잡기로 멈춘다.
      // 처리하지 않고 남긴 항목(멈춤·결과 모름 뒤 나머지)의 잡기는 모든 작업자가 끝난 뒤 푼다(작업 중인 잡기를 먼저 풀지 않는다)
      let budget = groups.size;
      const tokens: string[] = [];
      const worker = async (): Promise<void> => {
        while (budget > 0) {
          budget--;
          const claimed = await claims.claimOrders(request.requestId, this.o.nowMs(), 1);
          tokens.push(claimed.claimToken);
          if (claimed.items.length === 0) {
            budget = 0;
            return;
          }
          // 그 잡기의 기한은 이 작업자만 알고, 늘리면 바뀐다(W9-fix1 N3)
          const claim: HeldClaim = { token: claimed.claimToken, untilMs: claimed.claimedUntilMs };
          for (const group of groupByOrder(claimed.items).values()) await runGroup(group, claim);
        }
      };
      settled = await Promise.allSettled(Array.from({ length: workers }, worker));
      for (const token of tokens) {
        try {
          await claims.release(request.requestId, token);
        } catch (err) {
          // 풀지 못한 잡기는 기한(60초 [가정])이 지나면 다른 쪽이 다시 잡는다
          this.o.log?.warn({ event: 'event-refund-claim-release-failed', requestId: request.requestId, err: err instanceof Error ? err.name : 'unknown' }, 'event-refund-claim-release-failed');
        }
      }
    }

    const after = await this.o.store.items(request.requestId);
    // 회차 취소는 그 회차에 끝나지 않은 주문이 있으면 항목이 다 끝나도 COMPLETED로 가지 않는다(늦게 끝난 주문을 쓸어 담는다, ADR-0280 결정 5).
    // 잠근 쓰기의 next는 동기라 그 수는 잠그기 전에 센다(항목이 다 끝났을 때만)
    const allEnded = after.every((i) => i.status === 'REFUNDED' || i.status === 'FAILED' || i.status === 'NOT_APPLIED' || i.status === 'ACCOUNT_PENDING');
    const openOrders = allEnded && request.kind === 'CANCEL' && this.o.openOrders ? await this.o.openOrders.count(request.eventId) : 0;
    const added = newlyPaused.map(({ pg, reason }) => ({ pg, reason }));
    const writtenAtMs = this.o.nowMs();
    // 진행률은 잠근 DB 값의 멈춤에 이 실행이 새로 판정한 자동 정지만 더해 쓴다(아무것도 빼지 않는다, W9-fix1 N8).
    // 그사이 PAUSED가 됐으면 상태는 두고 멈춤만 더하며, 끝난 요청은 쓰지 않는다
    await this.o.store.updateLocked(request.requestId, (current) => {
      if (ended(current)) return undefined;
      const merged = mergePauses(pausedOf(current), { add: added });
      const windowOpen = this.#windowOpen(current);
      const progress = progressOf(after, merged, windowOpen);
      if (current.status === 'PAUSED') return { ...current, progress, updatedAtMs: writtenAtMs };
      let status = statusAfterRun(current, progress, merged, windowOpen);
      if (status === 'COMPLETED' && openOrders > 0) status = 'RUNNING';
      return { ...current, status, progress, updatedAtMs: writtenAtMs };
    });
    for (const p of newlyPaused) {
      if (p.reason === 'AUTO_CIRCUIT_OPEN') this.o.circuitPauses?.inc(p.pg);
      await this.o.alert?.raise({
        requestId: request.requestId,
        eventId: request.eventId,
        pg: p.pg,
        severity: 'SEV2',
        reason: p.reason,
        detail: p.detail,
        nowMs: this.o.nowMs(),
      });
    }
    // 작업자 하나가 던졌으면(항목 쓰기 실패 등) 다른 작업자·진행률 쓰기를 마친 뒤 그 오류를 올린다(남은 항목은 다음 틱이 다시 잡는다)
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed) throw failed.reason;
  }

  async #recordAttempt(request: EventCancellationRequest, item: EventRefundItem, target: EventRefundTarget, outcome: EventRefundAttemptOutcome): Promise<void> {
    await this.o.attempts?.record({ requestId: request.requestId, ticketId: item.ticketId, pg: item.pg, amount: target.ticketPrice, outcome, atMs: this.o.nowMs() });
  }

  /**
   * 재시도를 적거나(시도 상한이면 실패로 끝낸다) 그 뒤의 항목 상태를 돌려준다. UNKNOWN만 다음 실행에서 다시 집는다.
   * 그 밖 실패(업무 거절 목록 밖의 FAILED 답)는 시도 상한과 같은 끝내기(#finishItem)로 쓴다: 항목 FAILED·다음 시각 빔·행 실패 표시·failure_case_at·
   * 팬 REFUND_FAILED Outbox가 한 트랜잭션이다(W9-fix1 P3, transfer-refund §5 '주인').
   * 쓰기가 0행이면(잡기를 잃었거나 다른 쪽이 끝냄) LOST이고 아무것도 남기지 않는다(웨이브 끝 리뷰 K2)
   */
  async #retryOrFail(
    request: EventCancellationRequest,
    item: EventRefundItem,
    status: 'UNKNOWN' | 'FAILED',
    error: string,
    target: EventRefundTarget | undefined,
    claimToken?: string,
  ): Promise<'UNKNOWN' | 'FAILED' | 'LOST'> {
    const attempts = item.attempts + 1;
    if (status === 'FAILED' || attempts >= EVENT_REFUND_AUTO_STOP.maxAttempts) {
      return (await this.#finishItem(request, item, 'FAILED', error, target, { attempts, claimToken })) ? 'FAILED' : 'LOST';
    }
    const nextAttemptAtMs = this.o.nowMs() + eventRefundRetryDelayMs(attempts);
    const next: EventRefundItem = { ...item, status, attempts, lastError: error, nextAttemptAtMs };
    if (!(await this.#write(request, next, claimToken, {}))) {
      this.#claimLost(request, item);
      return 'LOST';
    }
    return status;
  }

  /**
   * 잡기 늘리기(W9-fix1 N3, transfer-refund §5 '잡기 늘리기'): 표를 결제사로 보내기 직전에 남은 기한(그 작업자가 아는 기한 − 지금)이
   * 40초 [가정]보다 짧으면 살아 있는 잡기만 지금 + 60초 [가정]로 늘린다. 늘리지 못하면(0행: 잡기를 잃었거나 기한이 지남) false이고,
   * 그 표를 보내지 않으며 시도 기록도 없다(경고 event-refund-item-claim-lost). 늘리기가 던지면 그 오류가 그대로 올라간다(보내지 않음)
   */
  async #keepClaim(request: EventCancellationRequest, item: EventRefundItem, claim: HeldClaim): Promise<boolean> {
    const claims = this.o.claims;
    if (!claims) return true;
    const nowMs = this.o.nowMs();
    if (claim.untilMs - nowMs >= EVENT_REFUND_CLAIM_EXTEND_BELOW_MS) return true;
    const untilMs = await claims.extend(request.requestId, claim.token, nowMs);
    if (untilMs === undefined) {
      this.#claimLost(request, item, 'extend');
      return false;
    }
    claim.untilMs = untilMs;
    return true;
  }

  /**
   * 항목을 환급·실패로 끝낸다. 쓰기가 되면 true다(쓰기 0행이면 잡기를 잃은 것이라 아무것도 남기지 않는다, 웨이브 끝 리뷰 K2).
   * FAILED면 같은 트랜잭션에서 그 취소 행(이 요청이 만들거나 전환한 REFUND_PENDING 행)에 refund_failed_at·refund_last_error를 쓰고(웨이브 끝 리뷰 K1·C1),
   * 차액 건으로 대신하지 않으면(failureNotice) 항목에 '일괄 환불 실패' 건을 열 대상(failure_case_at)으로 표시한다(다시 보기 2 N2). 건은 틱 끝 다시 열기가 열고,
   * 다시 열기 포트가 없는 옛 조립만 쓰기 뒤 여기서 한 번 연다
   */
  async #finishItem(
    request: EventCancellationRequest,
    item: EventRefundItem,
    status: 'REFUNDED' | 'FAILED' | 'ACCOUNT_PENDING',
    error: string | undefined,
    target: EventRefundTarget | undefined,
    o: { readonly attempts?: number; readonly failureNotice?: boolean; readonly claimToken?: string | undefined; readonly deductionGap?: { readonly cancellationId: string; readonly requestId: string } } = {},
  ): Promise<boolean> {
    const next: EventRefundItem = {
      ...item,
      status,
      attempts: o.attempts ?? item.attempts + (status === 'FAILED' ? 1 : 0),
      ...(error !== undefined ? { lastError: error } : {}),
      nextAttemptAtMs: undefined,
    };
    const outbox: EventRefundOutboxMessage[] =
      status === 'REFUNDED' && this.o.fanNotifier
        ? [this.o.fanNotifier.refunded(request, next, target, this.o.nowMs())]
        : status === 'FAILED' && this.o.fanNotifier
          ? [this.o.fanNotifier.failed(request, next, target, this.o.nowMs())]
          : [];
    const failureCase = status === 'FAILED' && (o.failureNotice ?? true);
    const written = await this.#write(request, next, o.claimToken, {
      outbox,
      ...(status === 'FAILED' ? { cancellationFailure: { lastError: error ?? 'failed' } } : {}),
      ...(o.deductionGap ? { deductionGap: o.deductionGap } : {}),
      ...(failureCase ? { failureCase: true as const } : {}),
      ...(status === 'ACCOUNT_PENDING' ? { accountPending: true as const } : {}),
    });
    if (!written) {
      this.#claimLost(request, item);
      return false;
    }
    if (failureCase) await this.#openFailureNow(request, next);
    return true;
  }

  /**
   * 다시 열기 포트가 없는 옛 조립(시험)만: 끝낸 실패 항목의 '일괄 환불 실패' 건을 처리 중에 한 번 연다. 실패하면 경고·지표만 남긴다
   * (CS 건 열기의 실패는 끝난 항목을 되돌리지 않는다, 웨이브 끝 리뷰 C2). 포트가 꽂힌 조립에서는 ops-svc를 부르지 않는다(틱 끝이 연다, 다시 보기 2 N1)
   */
  async #openFailureNow(request: EventCancellationRequest, item: EventRefundItem): Promise<void> {
    if (this.o.csOutbox || !this.o.notice) return;
    try {
      await this.o.notice.open({
        requestId: request.requestId,
        orderId: item.orderId,
        ticketId: item.ticketId,
        cancellationId: item.cancellationId,
        attempts: item.attempts,
        lastError: item.lastError ?? 'failed',
        nowMs: this.o.nowMs(),
      });
    } catch (err) {
      this.o.log?.warn(
        { event: 'event-refund-failure-notice-failed', requestId: request.requestId, cancellationId: item.cancellationId, err: err instanceof Error ? err.name : 'unknown' },
        'event-refund-failure-notice-failed: 일괄 환불 실패 CS 건을 열지 못했다(항목은 실패로 끝남)',
      );
      this.o.csCaseOpenFailures?.inc('EVENT_REFUND_FAILED');
    }
  }

  /** 항목 쓰기 하나: 잡기 값이 있으면 조건부 끝내기(claims.finish), 없으면 저장소 쓰기(끝난 상태를 덮지 않음). 썼으면 true */
  async #write(
    request: EventCancellationRequest,
    next: EventRefundItem,
    claimToken: string | undefined,
    side: {
      readonly outbox?: readonly EventRefundOutboxMessage[];
      readonly cancellationFailure?: { readonly lastError: string };
      readonly deductionGap?: { readonly cancellationId: string; readonly requestId: string };
      readonly failureCase?: true;
      readonly accountPending?: true;
    },
  ): Promise<boolean> {
    if (claimToken !== undefined && this.o.claims) {
      // NOT_APPLIED는 신청 창 닫기(markNotApplied)만 쓴다. 이 길로 오지 않는다
      if (next.status === 'NOT_APPLIED') throw new Error('일괄 환불 항목 끝내기에 NOT_APPLIED는 쓰지 않는다');
      return this.o.claims.finish({
        requestId: request.requestId,
        ticketId: next.ticketId,
        claimToken,
        status: next.status,
        attempts: next.attempts,
        ...(next.lastError !== undefined ? { lastError: next.lastError } : {}),
        ...(next.nextAttemptAtMs !== undefined ? { nextAttemptAtMs: next.nextAttemptAtMs } : {}),
        ...side,
      });
    }
    const { outbox, ...extra } = side;
    return (await this.o.store.updateItem(next, outbox ?? [], extra)) !== false;
  }

  /**
   * 잡기를 잃었거나 다른 쪽이 먼저 끝낸 항목(쓰기 0행). 시도 기록·팬 알림·CS 건을 남기지 않고 경고 한 번이다.
   * stage extend는 보내기 전 잡기 늘리기가 0행이라 그 표를 결제사로 보내지 않은 것이다(W9-fix1 N3)
   */
  #claimLost(request: EventCancellationRequest, item: EventRefundItem, stage: 'finish' | 'extend' = 'finish'): void {
    this.o.log?.warn(
      { event: 'event-refund-item-claim-lost', requestId: request.requestId, ticketId: item.ticketId, stage },
      stage === 'extend'
        ? 'event-refund-item-claim-lost: 보내기 전 잡기를 늘리지 못해(잡기를 잃었거나 기한이 지남) 그 표와 주문의 나머지를 보내지 않았다(시도 기록 없음)'
        : 'event-refund-item-claim-lost: 잡기를 잃었거나 다른 쪽이 먼저 끝낸 항목이라 쓰지 않았다(시도 기록·알림·CS 건 없음)',
    );
  }

  async #stopReason(pg: RefundPgProvider, nowMs: number): Promise<StopReason> {
    if (this.o.circuitOpen?.(pg)) return { reason: 'AUTO_CIRCUIT_OPEN', all: false, detail: { pg } };
    if (!this.o.attempts) return undefined;
    const consecutive = await this.o.attempts.consecutiveFailures(pg);
    if (consecutive >= EVENT_REFUND_AUTO_STOP.consecutiveFailures) {
      return { reason: 'AUTO_CONSECUTIVE_FAILURES', all: false, detail: { pg, consecutiveFailures: consecutive } };
    }
    const window = await this.o.attempts.window(pg, nowMs - EVENT_REFUND_AUTO_STOP.windowMs);
    if (window.calls >= EVENT_REFUND_AUTO_STOP.minCalls && rateBp(window.failures, window.calls) >= EVENT_REFUND_AUTO_STOP.failureRateBp) {
      return { reason: 'AUTO_FAILURE_RATE', all: false, detail: { pg, ...window, failureRateBp: rateBp(window.failures, window.calls) } };
    }
    if (window.failedAmount >= EVENT_REFUND_AUTO_STOP.failedAmount) {
      return { reason: 'AUTO_FAILED_AMOUNT', all: false, detail: { pg, ...window, failedAmountThreshold: EVENT_REFUND_AUTO_STOP.failedAmount } };
    }
    const all = await this.o.attempts.windowAll(nowMs - EVENT_REFUND_AUTO_STOP.windowMs);
    if (all.calls >= EVENT_REFUND_AUTO_STOP.minCalls && rateBp(all.rejects, all.calls) >= EVENT_REFUND_AUTO_STOP.rejectRateBp) {
      return { reason: 'AUTO_REJECT_RATE', all: true, detail: { pg, ...all, rejectRateBp: rateBp(all.rejects, all.calls) } };
    }
    return undefined;
  }

  #windowOpen(request: EventCancellationRequest): boolean {
    if (request.kind !== 'POSTPONE') return false;
    if (request.status === 'COMPLETED' || request.status === 'REJECTED') return false;
    return request.refundWindowClosesAtMs !== undefined && this.o.nowMs() < request.refundWindowClosesAtMs;
  }

  #windowOf(kind: EventRefundKind, i: EventRefundStartInput, nowMs: number): { postponedToMs: number; refundWindowClosesAtMs: number } | undefined {
    if (kind !== 'POSTPONE') return undefined;
    if (i.postponedToMs === undefined) throw new EventRefundError('INVALID', '연기는 바뀐 공연 시작 시각(postponedToMs)이 필요합니다');
    const closes = i.refundWindowClosesAtMs ?? i.postponedToMs;
    if (!Number.isSafeInteger(i.postponedToMs) || i.postponedToMs <= nowMs) throw new EventRefundError('INVALID', '바뀐 공연 시작 시각은 지금보다 뒤여야 합니다');
    if (!Number.isSafeInteger(closes) || closes <= nowMs || closes > i.postponedToMs) throw new EventRefundError('INVALID', '환급 신청 창의 닫힘은 지금과 바뀐 공연 시작 사이여야 합니다');
    return { postponedToMs: i.postponedToMs, refundWindowClosesAtMs: closes };
  }

  async #targets(eventId: string): Promise<readonly EventRefundTarget[]> {
    if (!UUID.test(eventId)) throw new EventRefundError('INVALID', 'eventId가 UUID가 아닙니다');
    return this.o.targets.list(eventId);
  }
}
