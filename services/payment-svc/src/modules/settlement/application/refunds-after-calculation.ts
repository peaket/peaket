// 계산 뒤(지급 뒤) 환급의 미수금(F-07-8 계획 I-02, settlement §7 '환불 미수금에서 수수료 몫을 뺀다', ADR-0197 결정 2, ADR-0380 결정 5, J-T11).
// 정산 일꾼 30분 tick이 끝난 결제 취소를 (끝난 시각, 결제 ID) 차례로 훑어, 그 결제가 든 살아 있는 회차 정산서마다
// '지금 정산 환급 − 그 판 계산 원본의 환급 줄 − 그 판·그 결제로 이미 만든 환급 미수금 합'이 0보다 크면 미수금 한 행을 만든다.
// - 근거 refund:{정산서 ID}:{결제 ID}:{누적 환급액}는 부분 유일이라 겹친 두 tick도 한 행이다(합 가드와 겹쳐 지킨다).
// - 다시 계산 대기(PENDING) 회차는 만들지 않는다(다시 계산이 새 판에 넣는다). 다시 계산에서 빠진 정산서(skipped)와 그 요청이 만든 새 판은 만든다.
// - 정산서가 없으면(계산 전) 만들지 않는다(06시 계산의 환급에 든다). 대사 불일치로 뺀 결제는 계산 원본에 없어 만들지 않는다(I-05 길).
// - 끝까지 성공한 tick만 읽은 자리를 옮긴다. 중간에 실패하면 던지고, 다음 tick이 같은 자리부터 다시 본다(부분 유일·합 가드로 중복 0).
import { uuidv7, type Clock } from '@peaket/platform';
import type { EventCommissionRateSource, SettlementPaymentSource, SettlementSignals, SettlementStore } from '../domain/ports.js';
import {
  isRecalculatedBy,
  refundReceivableOf,
  refundSourceRef,
  type ReceivableRecord,
  type SettlementRecalculationRecord,
  type StatementRecord,
} from '../domain/settlement.js';
import { partnerRefundOf } from '../domain/settlement.js';

export interface RefundsAfterCalculationDeps {
  readonly store: SettlementStore;
  readonly payments: SettlementPaymentSource;
  readonly clock: Clock;
  readonly eventCommission?: EventCommissionRateSource | undefined;
  readonly commissionRateBp?: number | undefined;
  readonly signals?: SettlementSignals | undefined;
}

/** 한 tick에 읽는 결제 수 200건 [가정] */
export const REFUND_SCAN_LIMIT = 200;
const SCAN_NAME = 'EVENT_REFUND' as const;
const EPOCH = new Date(0);

export class RefundsAfterCalculation {
  constructor(private readonly d: RefundsAfterCalculationDeps) {}

  async run(limit = REFUND_SCAN_LIMIT): Promise<{ created: number; skipped: number }> {
    if (!this.d.payments.listRefundsAfter) return { created: 0, skipped: 0 };
    const scan = await this.d.store.findRefundScan(SCAN_NAME);
    const after = { at: scan?.readThrough ?? EPOCH, paymentId: scan?.readThroughPaymentId ?? '' };
    const rows = await this.d.payments.listRefundsAfter(after, limit);
    let created = 0;
    let skipped = 0;
    const statementsOf = new Map<string, StatementRecord[]>();
    const pendingOf = new Map<string, SettlementRecalculationRecord | undefined>();
    for (const row of rows) {
      if (!statementsOf.has(row.eventId)) statementsOf.set(row.eventId, await this.d.store.listLiveEventStatements(row.eventId));
      if (!pendingOf.has(row.eventId)) pendingOf.set(row.eventId, await this.d.store.findPendingRecalculation(row.eventId));
      const pending = pendingOf.get(row.eventId);
      for (const s of statementsOf.get(row.eventId)!.filter((x) => x.pg === row.pg && x.pgStore === row.pgStore)) {
        // 다시 계산 대기 회차는 다시 계산이 넣는다(ADR-0380 결정 5). 빠진 정산서와 그 요청이 만든 새 판만 미수금이다
        if (pending && !pending.skippedStatementIds.includes(s.statementId) && !isRecalculatedBy(pending, s)) {
          skipped += 1;
          continue;
        }
        created += await this.createFor(s, row.paymentId, row.partnerRefund);
      }
    }
    const last = rows.at(-1);
    if (last) await this.d.store.saveRefundScan({ name: SCAN_NAME, readThrough: last.refundedAt, readThroughPaymentId: last.paymentId, updatedAt: new Date(this.d.clock.now()) });
    if (created > 0) this.d.signals?.refundReceivableCreated?.(created);
    return { created, skipped };
  }

  /** 정산서 하나의 모든 결제에 대해 계산 뒤 환급 미수금을 맞춘다(다시 계산에서 빠진 정산서로 옮길 때, 대기 중에 지나간 환급까지) */
  async settleStatement(s: StatementRecord): Promise<number> {
    if (s.eventId === null) return 0;
    const payments = await this.d.payments.listEventPayments(s.eventId, s.pg, s.pgStore);
    let created = 0;
    for (const p of payments) created += await this.createFor(s, p.paymentId, partnerRefundOf(p));
    if (created > 0) this.d.signals?.refundReceivableCreated?.(created);
    return created;
  }

  /** 정산서 하나·결제 하나의 빠진 환급만큼 미수금 한 행. 만들었으면 1 */
  async createFor(s: StatementRecord, paymentId: string, partnerRefund: number): Promise<number> {
    const sources = await this.d.store.listStatementSources(s.statementId);
    // 그 판이 센 결제만(계산 원본에 판매 대금 줄이 있는 것). 대사 불일치로 뺀 결제·계산 뒤 승인된 결제는 대상이 아니다
    if (!sources.some((x) => x.paymentId === paymentId && x.kind === 'GROSS')) return 0;
    const counted = sources.filter((x) => x.paymentId === paymentId && x.kind === 'REFUND').reduce((n, x) => n + x.amount, 0);
    const already = await this.d.store.sumRefundReceivables(s.statementId, paymentId);
    const refundAmount = partnerRefund - counted - already;
    if (refundAmount <= 0) return 0;
    const commissionRateBp = s.commissionRateBp ?? (s.eventId && this.d.eventCommission ? await this.d.eventCommission.rateBp(s.eventId) : undefined) ?? this.d.commissionRateBp;
    if (commissionRateBp === undefined) return 0;
    const parts = refundReceivableOf({ refundAmount, commissionRateBp });
    if (parts.amount <= 0) return 0;
    const now = new Date(this.d.clock.now());
    const record: ReceivableRecord = {
      receivableId: uuidv7(this.d.clock),
      promoterId: s.promoterId,
      pg: s.pg,
      cause: 'REFUND_AFTER_PAYOUT',
      eventId: s.eventId,
      sourceRef: refundSourceRef(s.statementId, paymentId, partnerRefund),
      amount: parts.amount,
      remaining: parts.amount,
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
      statementId: s.statementId,
      commissionRateBp,
      refundAmount,
      commissionShare: parts.commissionShare,
      commissionVatShare: parts.commissionVatShare,
    };
    return (await this.d.store.insertReceivableIfAbsent(record)) ? 1 : 0;
  }
}
