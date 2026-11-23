// 대사 불일치로 계산에서 뺀 결제가 풀린 뒤의 처리(F-07-8 계획 I-05, ADR-0380 결정 7, settlement §4.1 '대사가 끝나지 않은 결제', §12 셋째 줄, J-T23 ③).
// 정산 일꾼 30분 tick이 살아 있는 회차 정산서의 뺀 결제(`결제 ID:RECONCILIATION_OPEN`) 가운데 대사 차이가 닫힌 결제마다 순액
// (판매 대금 − 환급 − 수수료 몫 − 부가세, J-T11 식과 같은 버림)을 셈해 조정 제안 CS 건(SETTLEMENT_ADJUSTMENT_SUGGESTED)을 연다.
// 조정 행은 만들지 않는다(정산 금액을 바꾸는 길은 §4.3 2인 승인을 그대로 거친다). 지급 전이면 그 정산서, 지급 뒤면 같은 파트너·같은 결제사의
// 다음 지급 전 정산서가 대상이고, 그런 정산서가 없으면 다음 tick에 다시 본다. 처리한 항목에는 `:RESOLVED`를 더해 다시 열지 않는다.
import type { Clock } from '@peaket/platform';
import type { SettlementPaymentSource, SettlementStore } from '../domain/ports.js';
import { partnerRefundOf, refundReceivableOf, type SettlementCaseRequestRecord, type StatementRecord, type StatementStatus } from '../domain/settlement.js';

export interface ExcludedPaymentResolutionDeps {
  readonly store: SettlementStore;
  readonly payments: SettlementPaymentSource;
  readonly clock: Clock;
  readonly commissionRateBp?: number | undefined;
}

const OPEN_SUFFIX = ':RECONCILIATION_OPEN';
const RESOLVED_SUFFIX = ':RESOLVED';
/** 지급 전(묶이지 않은) 정산서의 상태 */
const BEFORE_PAYOUT: readonly StatementStatus[] = ['NOTIFIED', 'DISPUTED', 'CONFIRMED', 'HELD'];
export const EXCLUDED_RESOLUTION_LIMIT = 100;

const beforePayout = (s: StatementRecord): boolean => BEFORE_PAYOUT.includes(s.status) && s.payoutBatchId === null;

export class ExcludedPaymentResolution {
  constructor(private readonly d: ExcludedPaymentResolutionDeps) {}

  async run(limit = EXCLUDED_RESOLUTION_LIMIT): Promise<{ suggested: number; waiting: number }> {
    let suggested = 0;
    let waiting = 0;
    for (const s of await this.d.store.listStatementsWithOpenExclusions(limit)) {
      if (s.eventId === null) continue;
      const payments = await this.d.payments.listEventPayments(s.eventId, s.pg, s.pgStore);
      for (const entry of s.excludedPayments.filter((e) => e.endsWith(OPEN_SUFFIX))) {
        const paymentId = entry.slice(0, -OPEN_SUFFIX.length);
        const p = payments.find((x) => x.paymentId === paymentId);
        // 아직 대사 차이가 남았으면(또는 원장에서 볼 수 없으면) 다음 tick에 다시 본다
        if (!p || p.excludedReason) continue;
        const target = beforePayout(s) ? s : await this.#nextBeforePayout(s);
        if (!target) {
          waiting += 1;
          continue;
        }
        const rate = s.commissionRateBp ?? this.d.commissionRateBp;
        if (rate === undefined) continue;
        const base = Math.max(0, p.amount - partnerRefundOf(p));
        const net = refundReceivableOf({ refundAmount: base, commissionRateBp: rate }).amount;
        const now = new Date(this.d.clock.now());
        const caseRequest: SettlementCaseRequestRecord = {
          eventKey: `reconciliation-resolved:${target.statementId}:${paymentId}`,
          kind: 'SETTLEMENT_ADJUSTMENT_SUGGESTED',
          sourceId: target.statementId,
          createdAt: now,
          requestedAt: null,
          // 계좌번호·예금주명은 싣지 않는다. 결제 ID·원래 정산서·순액만
          detail: `대사 불일치로 정산서 ${s.statementId}에서 뺀 결제 ${paymentId}의 대사가 풀렸습니다. 순액 ${net}원(판매 대금 ${p.amount}원 − 환급 ${p.amount - base}원 − 수수료·부가세)을 정산서 ${target.statementId}에 수기 조정(LEDGER_ERROR)으로 제안합니다. 조정은 2인 승인 뒤 적용합니다.`,
        };
        if (await this.d.store.resolveExcludedPayment({ statementId: s.statementId, entry, resolvedEntry: `${entry}${RESOLVED_SUFFIX}`, caseRequest, at: now })) suggested += 1;
      }
    }
    return { suggested, waiting };
  }

  /** 같은 파트너·같은 결제사의 다음 지급 전 정산서(지급일이 이른 차례, 그 정산서 밖) */
  async #nextBeforePayout(s: StatementRecord): Promise<StatementRecord | undefined> {
    const rows = (await this.d.store.listStatementsOfPromoter(s.promoterId, s.pg, BEFORE_PAYOUT)).filter((x) => x.statementId !== s.statementId && beforePayout(x));
    return rows.sort((a, b) => (a.payoutDate ?? '9999').localeCompare(b.payoutDate ?? '9999') || a.createdAt.getTime() - b.createdAt.getTime())[0];
  }
}
