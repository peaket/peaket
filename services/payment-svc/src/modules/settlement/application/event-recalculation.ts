// 회차 취소·연기 환급의 정산 보류와 다시 계산(F-07-8 계획 I-03, ADR-0380 결정 1·4·5·6·8, settlement §4.1 '다시 계산'·§4.4·§7·§12, 03 §2.12 T10·T14~T17·T19).
// - 보류 열기(확정 직후, purchase-svc가 부름): 요청 한 행(PENDING)을 쓰고 그 회차의 살아 있는 정산서를 상태별로 다룬다(recalculationActionOf).
//   묶이지 않은 CONFIRMED는 HELD(RECALCULATION), 묶음에 묶인 접수 전 CONFIRMED는 묶음에서 빼고 상계를 되돌린 뒤 HELD, 토스 REQUESTED 예약지급은 취소 뒤 T10,
//   포트원은 수기 정산건 취소 뒤 T10, 지급 건이 진행 중·끝난 정산서는 다시 계산하지 않는다(skipped). 결제사 취소가 실패하면 그 정산서만 다시 하기(retrying)다.
// - 완료(일괄 환불 끝): 대상 정산서마다 한 트랜잭션에 새 판(판 + 1, 옛 판의 고정 수수료율·적용된 조정 합, 바로 NOTIFIED·2영업일)과 옛 판 SUPERSEDED,
//   남은 상계 되돌림, 옛 판 음수 미수금 닫기(남은 금액만큼, 돌려받은 금액은 새 판 조정 합에)를 쓴다. 다시 하기가 남으면 요청은 PENDING에 남는다.
// - 다시 하기(정산 일꾼 30분 tick): PENDING 요청을 다시 돌린다. 완료를 받은 요청이면 취소에 성공한 정산서를 그 자리에서 다시 계산하고, 끝내 안 되면 skipped로 옮겨
//   대기 동안의 환급을 계산 뒤 환급 미수금으로 잡는다(U-R1).
// 결과(recalculated)는 저장소의 새 판에서 다시 세므로, 겹친 두 완료가 같은 답을 준다. 외부 결제사 호출은 트랜잭션 밖이다.
import { uuidv7, type Clock } from '@peaket/platform';
import type { EventCommissionRateSource, PayoutWrite, PortonePlatformTransport, ReverseOffset, SettlementApprovalLog, SettlementPaymentSource, SettlementStore, StatementTransition, TossPayoutTransport } from '../domain/ports.js';
import { recalculationActionOf, type RecalculationAction } from '../domain/recalculation.js';
import {
  calculateEventStatement,
  dateOnly,
  DISPUTE_WINDOW_BUSINESS_DAYS,
  isRecalculatedBy,
  negativeStatementSourceRef,
  payoutAmountOf,
  payoutEvent,
  recalculationView,
  SettlementProblem,
  statementEvent,
  type EventRecalculationView,
  type PayoutRecord,
  type RecalculatedStatement,
  type RecalculationKind,
  type SettlementRecalculationRecord,
  type StatementAuditRecord,
  type StatementRecord,
  type StatementStatus,
} from '../domain/settlement.js';
import { addBusinessDays as addKstBusinessDays } from '../domain/business-calendar.js';
import type { RefundsAfterCalculation } from './refunds-after-calculation.js';

export interface EventRecalculationDeps {
  readonly store: SettlementStore;
  readonly payments: SettlementPaymentSource;
  readonly clock: Clock;
  readonly holidays: ReadonlySet<string>;
  readonly refunds: RefundsAfterCalculation;
  readonly eventCommission?: EventCommissionRateSource | undefined;
  readonly commissionRateBp?: number | undefined;
  readonly tossTransport?: TossPayoutTransport | undefined;
  readonly portone?: PortonePlatformTransport | undefined;
  readonly log?: SettlementApprovalLog | undefined;
  /** 결제사 취소 실패의 구조화 로그(settlement_recalculation_cancel_failed, 정산서 ID·결제사·까닭 종류만) */
  readonly onCancelFailed?: ((o: { statementId: string; pg: string; reason: string }) => void) | undefined;
}

/** 다시 하기 tick의 한 번 상한 [가정] */
export const RECALCULATION_RETRY_LIMIT = 50;
/** 완료 때 다시 계산할 수 있는 출발 상태(옛 판 감사 T14~T17·T19) */
const RECALCULABLE: readonly StatementStatus[] = ['NOTIFIED', 'DISPUTED', 'CONFIRMED', 'HELD', 'CARRIED_OVER'];

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];
const without = (xs: readonly string[], id: string): string[] => xs.filter((x) => x !== id);
const errorKind = (e: unknown): string => (e instanceof Error ? (e.name === 'Error' ? 'error' : e.name).slice(0, 60) : 'unknown');

type HoldOutcome = 'HELD' | 'KEPT' | 'SKIPPED' | 'RETRY';

export class EventRecalculations {
  constructor(private readonly d: EventRecalculationDeps) {}

  #now(): Date {
    return new Date(this.d.clock.now());
  }

  #audit(statementId: string, fromStatus: StatementStatus, toStatus: StatementStatus, reason: string, at: Date): StatementAuditRecord {
    return { auditId: uuidv7(this.d.clock), statementId, fromStatus, toStatus, reason, actor: 'system', createdAt: at };
  }

  /** 보류 열기(PUT …/event-recalculations/{requestId}). 같은 요청 ID·같은 본문이면 남은 일만 하고 같은 답, 다른 회차·종류면 409 */
  async open(input: { requestId: string; eventId: string; kind: RecalculationKind; confirmedAt: Date }): Promise<EventRecalculationView> {
    const now = this.#now();
    const fresh: SettlementRecalculationRecord = {
      requestId: input.requestId,
      eventId: input.eventId,
      kind: input.kind,
      state: 'PENDING',
      confirmedAt: input.confirmedAt,
      openedAt: now,
      completedAt: null,
      partial: false,
      heldStatementIds: [],
      skippedStatementIds: [],
      retryStatementIds: [],
      result: null,
      updatedAt: now,
    };
    const { record } = await this.d.store.insertRecalculation(fresh);
    if (record.eventId !== input.eventId || record.kind !== input.kind) throw new SettlementProblem('recalculation-conflict', 409, '같은 요청 ID로 다른 회차·종류의 다시 계산이 있습니다');
    if (record.state === 'DONE') return record.result ?? recalculationView(record);
    const after = await this.#holdPass(record);
    return recalculationView(after);
  }

  /** 완료(POST …/{requestId}/completion). DONE이면 처음 답. 없으면 404 */
  async complete(requestId: string, input: { completedAt: Date; partial?: boolean }): Promise<EventRecalculationView> {
    let rec = await this.d.store.findRecalculation(requestId);
    if (!rec) throw new SettlementProblem('not-found', 404, '찾을 수 없습니다');
    if (rec.state === 'DONE') return rec.result ?? recalculationView(rec);
    if (rec.completedAt === null) {
      // 완료를 받은 것을 먼저 남긴다(이 호출이 중간에 끊겨도 다시 하기 tick이 이어 간다)
      const next: SettlementRecalculationRecord = { ...rec, completedAt: input.completedAt, partial: input.partial ?? false, updatedAt: this.#now() };
      if (await this.d.store.saveRecalculation(next)) rec = next;
      else {
        rec = await this.d.store.findRecalculation(requestId);
        if (!rec) throw new SettlementProblem('not-found', 404, '찾을 수 없습니다');
        if (rec.state === 'DONE') return rec.result ?? recalculationView(rec);
      }
    }
    return this.#finish(rec);
  }

  /** 다시 하기(정산 일꾼 30분 tick). retried = 다시 하기 목록에서 빠진 정산서 수, pending = 아직 PENDING인 요청 수 */
  async retry(limit = RECALCULATION_RETRY_LIMIT): Promise<{ retried: number; pending: number }> {
    let retried = 0;
    let pending = 0;
    for (const rec of await this.d.store.listPendingRecalculations(limit)) {
      const before = rec.retryStatementIds.length;
      const after = rec.completedAt === null ? await this.#holdPass(rec) : await this.#finishRecord(rec);
      retried += Math.max(0, before - after.retryStatementIds.length);
      if (after.state === 'PENDING') pending += 1;
    }
    return { retried, pending };
  }

  /** 보류 열기·다시 하기: 살아 있는 정산서마다 상태별 처리. 이미 한 것은 건너뛴다(멱등) */
  async #holdPass(rec: SettlementRecalculationRecord): Promise<SettlementRecalculationRecord> {
    let held = [...rec.heldStatementIds];
    let skipped = [...rec.skippedStatementIds];
    let retry = [...rec.retryStatementIds];
    for (const s of await this.d.store.listLiveEventStatements(rec.eventId)) {
      if (isRecalculatedBy(rec, s) || skipped.includes(s.statementId)) continue;
      const outcome = await this.#hold(rec, s);
      if (outcome === 'HELD') {
        held = uniq([...held, s.statementId]);
        retry = without(retry, s.statementId);
      } else if (outcome === 'SKIPPED') {
        skipped = uniq([...skipped, s.statementId]);
        retry = without(retry, s.statementId);
        await this.d.refunds.settleStatement(s);
      } else if (outcome === 'RETRY') {
        retry = uniq([...retry, s.statementId]);
      } else {
        retry = without(retry, s.statementId);
      }
    }
    return this.#save({ ...rec, heldStatementIds: held, skippedStatementIds: skipped, retryStatementIds: retry, updatedAt: this.#now() });
  }

  async #save(next: SettlementRecalculationRecord): Promise<SettlementRecalculationRecord> {
    if (await this.d.store.saveRecalculation(next)) return next;
    // 다른 파드가 먼저 끝냈다(DONE은 덮지 않는다)
    return (await this.d.store.findRecalculation(next.requestId)) ?? next;
  }

  async #livePayouts(s: StatementRecord): Promise<PayoutRecord[]> {
    if (s.payoutBatchId === null) return [];
    const rows = (await this.d.store.listPayouts(s.payoutBatchId)).filter((p) => p.statementId === s.statementId);
    const replaced = new Set(rows.map((r) => r.retryOfPayoutId).filter((id): id is string => id !== null));
    return rows.filter((r) => !replaced.has(r.payoutId));
  }

  /** 정산서 하나의 보류 처리 */
  async #hold(rec: SettlementRecalculationRecord, s: StatementRecord): Promise<HoldOutcome> {
    const payouts = await this.#livePayouts(s);
    const action: RecalculationAction = recalculationActionOf({ status: s.status, payoutBatchId: s.payoutBatchId, pg: s.pg, payouts });
    switch (action) {
      case 'KEEP':
        return 'KEPT';
      case 'SKIP':
        return 'SKIPPED';
      case 'HOLD':
        return (await this.#writeHold(rec, s, [])) ? 'HELD' : 'RETRY';
      case 'UNBATCH_HOLD':
        // 결제사에 보낸 지급 건이 있으면 묶음에서 뺄 수 없다(다음 tick이 다시 본다)
        if (payouts.some((p) => p.status !== 'CANCELED' && p.status !== 'FAILED')) return 'RETRY';
        return (await this.#writeHold(rec, s, [])) ? 'HELD' : 'RETRY';
      case 'CANCEL_TOSS':
        return this.#cancelToss(rec, s, payouts);
      case 'CANCEL_PORTONE':
        return this.#cancelPortone(rec, s, payouts);
    }
  }

  /** T7·T10 보류 한 쓰기: 출발 상태 그대로일 때만 HELD(RECALCULATION)·감사·PAYOUT_HELD, 묶음 빼기·상계 되돌림·취소한 지급 건을 한 트랜잭션에 */
  async #writeHold(rec: SettlementRecalculationRecord, s: StatementRecord, cancelled: readonly PayoutRecord[]): Promise<boolean> {
    const now = this.#now();
    const reverseOffsets = s.status === 'CONFIRMED' && s.payoutBatchId === null ? [] : await this.#reversals(s, now);
    const reversed = reverseOffsets.reduce((n, r) => n + r.amount, 0);
    const offsetAmount = s.offsetAmount - reversed;
    const payoutAmount = payoutAmountOf({ ...s, offsetAmount });
    const audit = this.#audit(s.statementId, s.status, 'HELD', `event-recalculation:${rec.requestId}`, now);
    const held: StatementRecord = { ...s, status: 'HELD', holdReason: 'RECALCULATION', offsetAmount, payoutAmount, payoutBatchId: s.status === 'CONFIRMED' ? null : s.payoutBatchId, updatedAt: now };
    const unbatch = s.status === 'CONFIRMED' && s.payoutBatchId !== null ? { batchId: s.payoutBatchId, amount: s.payoutAmount } : undefined;
    const transition: StatementTransition = {
      statementId: s.statementId,
      from: [s.status],
      to: 'HELD',
      set: { holdReason: 'RECALCULATION', offsetAmount, payoutAmount },
      expect: { offsetAmount: s.offsetAmount, ...(s.status === 'CONFIRMED' && s.payoutBatchId === null ? { unbatched: true } : {}), ...(s.payoutBatchId !== null ? { payoutBatchId: s.payoutBatchId } : {}) },
      ...(unbatch ? { unbatch } : {}),
      ...(reverseOffsets.length > 0 ? { reverseOffsets } : {}),
      updatedAt: now,
      audits: [audit],
      events: [payoutEvent(held, 'PAYOUT_HELD', payoutAmount, now, audit.auditId)],
    };
    const write: PayoutWrite = {
      ...(cancelled.length > 0 ? { payoutUpdates: cancelled.map((p) => ({ payoutId: p.payoutId, from: ['REQUESTED' as const], set: { status: 'CANCELED' as const, updatedAt: now } })) } : {}),
      transitions: [transition],
    };
    return (await this.d.store.writePayoutChanges(write)).ok;
  }

  async #reversals(s: StatementRecord, at: Date): Promise<ReverseOffset[]> {
    return (await this.d.store.listOffsetMovements(s.statementId)).map((m) => ({ reversalId: uuidv7(this.d.clock), moveId: m.moveId!, receivableId: m.receivableId, amount: m.amount, at }));
  }

  /** 남은 지급 건(REQUESTED)의 토스 예약지급 취소(F-07-7 cancelPayout). 모두 되면 T10, 하나라도 실패하면 취소된 것만 쓰고 다시 하기 */
  async #cancelToss(rec: SettlementRecalculationRecord, s: StatementRecord, payouts: readonly PayoutRecord[]): Promise<HoldOutcome> {
    const live = payouts.filter((p) => p.status === 'REQUESTED');
    if (!this.d.tossTransport || live.some((p) => p.pgPayoutId === null)) return 'RETRY';
    const done: PayoutRecord[] = [];
    let failed = false;
    for (const p of live) {
      try {
        await this.d.tossTransport.cancelPayout(s.pgStore, p.pgPayoutId!);
        done.push(p);
      } catch (e) {
        failed = true;
        this.d.onCancelFailed?.({ statementId: s.statementId, pg: s.pg, reason: errorKind(e) });
      }
    }
    if (failed) {
      if (done.length > 0) {
        const now = this.#now();
        await this.d.store.writePayoutChanges({ payoutUpdates: done.map((p) => ({ payoutId: p.payoutId, from: ['REQUESTED'], set: { status: 'CANCELED', updatedAt: now } })) });
      }
      return 'RETRY';
    }
    return (await this.#writeHold(rec, s, done)) ? 'HELD' : 'RETRY';
  }

  /** 포트원 수기 정산건 취소(정산서 ID = 수기 정산건 ID). 포트원 지급대행이 꺼진 조립은 취소할 결제사 건이 없어 바로 T10 */
  async #cancelPortone(rec: SettlementRecalculationRecord, s: StatementRecord, payouts: readonly PayoutRecord[]): Promise<HoldOutcome> {
    if (this.d.portone) {
      try {
        await this.d.portone.cancelManualTransfer(s.statementId);
      } catch (e) {
        this.d.onCancelFailed?.({ statementId: s.statementId, pg: s.pg, reason: errorKind(e) });
        return 'RETRY';
      }
    }
    return (await this.#writeHold(
      rec,
      s,
      payouts.filter((p) => p.status === 'REQUESTED'),
    ))
      ? 'HELD'
      : 'RETRY';
  }

  async #finish(rec: SettlementRecalculationRecord): Promise<EventRecalculationView> {
    const after = await this.#finishRecord(rec);
    if (after.state === 'DONE') return after.result ?? recalculationView(after);
    return recalculationView(after, await this.#recalculated(after));
  }

  /** 완료를 받은 요청: 정산서마다 다시 계산(필요하면 먼저 보류), 다시 하기가 남지 않으면 DONE */
  async #finishRecord(rec: SettlementRecalculationRecord): Promise<SettlementRecalculationRecord> {
    let held = [...rec.heldStatementIds];
    let skipped = [...rec.skippedStatementIds];
    let retry = [...rec.retryStatementIds];
    const completedAt = this.#now();
    for (const s0 of await this.d.store.listLiveEventStatements(rec.eventId)) {
      if (isRecalculatedBy(rec, s0) || skipped.includes(s0.statementId)) continue;
      let s = s0;
      // 결제사에 넘어간(SCHEDULED)·묶음에 묶인 CONFIRMED·지급이 끝난 정산서는 먼저 보류 처리를 한다
      if (s.status === 'SCHEDULED' || s.status === 'PAID' || s.status === 'FAILED' || (s.status === 'CONFIRMED' && s.payoutBatchId !== null)) {
        const outcome = await this.#hold(rec, s);
        if (outcome === 'SKIPPED') {
          skipped = uniq([...skipped, s.statementId]);
          retry = without(retry, s.statementId);
          await this.d.refunds.settleStatement(s);
          continue;
        }
        if (outcome !== 'HELD') {
          retry = uniq([...retry, s.statementId]);
          continue;
        }
        held = uniq([...held, s.statementId]);
        const reread = await this.d.store.findStatementById(s.statementId);
        if (!reread) continue;
        s = reread;
      }
      if (!RECALCULABLE.includes(s.status) || (s.status === 'CONFIRMED' && s.payoutBatchId !== null)) continue;
      await this.#recalculate(rec, s, completedAt);
      retry = without(retry, s.statementId);
    }
    const next: SettlementRecalculationRecord = { ...rec, heldStatementIds: held, skippedStatementIds: skipped, retryStatementIds: retry, updatedAt: this.#now() };
    if (retry.length > 0) return this.#save(next);
    const done: SettlementRecalculationRecord = { ...next, state: 'DONE' };
    const result = recalculationView(done, await this.#recalculated(done));
    return this.#save({ ...done, result });
  }

  /** 정산서 하나를 다시 계산한다(한 트랜잭션). 다른 완료가 먼저 썼으면 아무것도 하지 않는다 */
  async #recalculate(rec: SettlementRecalculationRecord, old: StatementRecord, now: Date): Promise<void> {
    if (old.eventId === null) return;
    const [payments, account] = await Promise.all([this.d.payments.listEventPayments(old.eventId, old.pg, old.pgStore), this.d.store.findPayoutAccount(old.promoterId)]);
    const reverseOffsets = await this.#reversals(old, now);
    const supersedeAudit = this.#audit(old.statementId, old.status, 'SUPERSEDED', `recalculated:${rec.requestId}`, now);
    const disputeDueAt = addKstBusinessDays(now, DISPUTE_WINDOW_BUSINESS_DAYS, this.d.holidays);
    // 새 판의 지급일: 옛 지급일이 새 이의 기한 뒤면 그대로, 아니면 이의 기한 다음 영업일 [가정]
    const freshPayoutDate = dateOnly(addKstBusinessDays(disputeDueAt, 1, this.d.holidays));
    const payoutDate = old.payoutDate !== null && old.payoutDate >= freshPayoutDate ? old.payoutDate : freshPayoutDate;
    // 새 판은 옛 판의 고정 수수료율을 쓴다(ADR-0380 결정 6). 0033 이전 판(칸 없음)은 회차 수수료율 원천을 본다
    const commissionRateBp = old.commissionRateBp ?? (this.d.eventCommission ? await this.d.eventCommission.rateBp(old.eventId) : undefined) ?? this.d.commissionRateBp;
    if (commissionRateBp === undefined) throw new SettlementProblem('event-commission-rate-unavailable', 503, '회차 수수료율을 확인할 수 없습니다');
    const statementId = uuidv7(this.d.clock);
    const ok = await this.d.store.supersedeStatement({
      old: {
        statementId: old.statementId,
        from: [old.status],
        to: 'SUPERSEDED',
        expect: { offsetAmount: old.offsetAmount, adjustmentAmount: old.adjustmentAmount ?? 0, ...(old.status === 'CONFIRMED' ? { unbatched: true } : {}) },
        ...(reverseOffsets.length > 0 ? { reverseOffsets } : {}),
        updatedAt: now,
        audits: [supersedeAudit],
        events: [],
      },
      negativeSourceRef: negativeStatementSourceRef(old.statementId),
      closedAt: now,
      decide: ({ negative }) => {
        // 옛 판 음수 미수금: 남은 금액만큼 닫고, 이미 돌려받은 금액(금액 − 남은 금액)은 새 판 조정 합에 더한다(ADR-0380 결정 8)
        const recovered = negative ? negative.amount - negative.remaining : 0;
        const { record, sources } = calculateEventStatement({
          promoterId: old.promoterId,
          eventId: old.eventId!,
          pg: old.pg,
          pgStore: old.pgStore,
          commissionRateBp,
          payments,
          kyc: undefined,
          account,
          now,
          statementId,
          revision: old.revision + 1,
          supersedesId: old.statementId,
          adjustmentAmount: (old.adjustmentAmount ?? 0) + recovered,
          payoutDate,
        });
        const notified: StatementRecord = { ...record, status: 'NOTIFIED', holdReason: null, disputeDueAt, updatedAt: now };
        const notifyAudit = this.#audit(statementId, 'CALCULATED', 'NOTIFIED', `recalculated:${rec.requestId}`, now);
        const audits: StatementAuditRecord[] = negative ? [this.#audit(statementId, 'NOTIFIED', 'NOTIFIED', `negative-recovered:${negative.receivableId}:${recovered}`, now)] : [];
        return {
          record,
          sources,
          notify: { disputeDueAt, audit: notifyAudit, event: statementEvent(notified, 'STATEMENT_NOTIFIED', now, notifyAudit.auditId) },
          audits,
          ...(negative ? { closeNegative: { receivableId: negative.receivableId, amount: negative.remaining, moveId: uuidv7(this.d.clock), at: now } } : {}),
        };
      },
    });
    void ok;
  }

  /** 그 요청이 만든 새 판(저장소에서 다시 센다. 겹친 두 완료가 같은 답을 준다) */
  async #recalculated(rec: SettlementRecalculationRecord): Promise<RecalculatedStatement[]> {
    const out: RecalculatedStatement[] = [];
    for (const s of await this.d.store.listLiveEventStatements(rec.eventId)) {
      if (!isRecalculatedBy(rec, s) || s.supersedesId === null) continue;
      const negative = await this.d.store.findReceivableBySourceRef(negativeStatementSourceRef(s.supersedesId));
      let negativeClosed: RecalculatedStatement['negativeClosed'] = null;
      if (negative) {
        const closedAmount = (await this.d.store.listReceivableMovesForReceivable(negative.receivableId)).filter((m) => m.kind === 'SUPERSEDED').reduce((n, m) => n + m.amount, 0);
        negativeClosed = { receivableId: negative.receivableId, closedAmount, recoveredCredit: negative.amount - closedAmount };
      }
      out.push({ oldStatementId: s.supersedesId, newStatementId: s.statementId, revision: s.revision, negativeClosed });
    }
    return out.sort((a, b) => a.oldStatementId.localeCompare(b.oldStatementId));
  }

  /** 그 회차에 PENDING 다시 계산이 있고 그 정산서가 그 요청이 만든 새 판이 아니면 그 요청(지급 묶음 판정·재확정이 본다) */
  async pendingFor(s: Pick<StatementRecord, 'eventId' | 'supersedesId' | 'createdAt'>): Promise<SettlementRecalculationRecord | undefined> {
    if (s.eventId === null) return undefined;
    const rec = await this.d.store.findPendingRecalculation(s.eventId);
    return rec && !isRecalculatedBy(rec, s) ? rec : undefined;
  }
}
