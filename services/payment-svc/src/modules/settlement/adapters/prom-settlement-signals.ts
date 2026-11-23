// 정산 지급 지표 다섯(F-07-6 LCH-110, settlement §11, ADR-0369 결정 12). PromPaymentWebhookSignals와 같은 꼴이다:
// 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다. 경보 규칙·대시보드 패널은 정리 목록 C-04다.
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { SettlementSignals } from '../domain/ports.js';
import type { Pg, PgStore } from '../domain/settlement.js';

const FAILURE_CLASSES = ['ACCOUNT', 'TRANSIENT', 'LIMIT_KYC', 'UNKNOWN'] as const;

export class PromSettlementSignals implements SettlementSignals {
  readonly #failed = new Counter({ name: 'settlement_payout_failed_total', help: '지급 건 실패 반영 수(결제사·실패 갈래)', labelNames: ['pg', 'reason'] as const, registers: [] });
  readonly #signatureInvalid = new Counter({ name: 'settlement_webhook_signature_invalid_total', help: '서명이 맞지 않아 거절한 정산 웹훅 수', registers: [] });
  readonly #kycRequired = new Gauge({ name: 'settlement_seller_kyc_required', help: '지금 KYC_REQUIRED인 셀러 수(결제사)', labelNames: ['pg'] as const, registers: [] });
  readonly #balanceDiff = new Gauge({ name: 'settlement_pg_balance_diff_krw', help: '마지막 결제사 잔액 대사의 차이(보이는 잔액 − 있어야 할 잔액, 원)', labelNames: ['pg', 'store'] as const, registers: [] });
  readonly #overdue = new Counter({ name: 'settlement_payout_overdue_total', help: '지급일 다음 영업일 12시까지 끝나지 않은 지급 건 수(결제사)', labelNames: ['pg'] as const, registers: [] });

  constructor() {
    // 처음 일어나기 전에도 경보식이 값을 보게 토스 이름표를 0으로 미리 보인다
    for (const reason of FAILURE_CLASSES) this.#failed.inc({ pg: 'TOSS', reason }, 0);
    this.#signatureInvalid.inc(0);
    this.#overdue.inc({ pg: 'TOSS' }, 0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    for (const m of [this.#failed, this.#signatureInvalid, this.#kycRequired, this.#balanceDiff, this.#overdue]) registry.registerMetric(m);
    return this;
  }

  payoutFailed(pg: Pg, reason: string): void {
    this.#failed.inc({ pg, reason });
  }

  webhookSignatureInvalid(): void {
    this.#signatureInvalid.inc();
  }

  sellerKycRequired(pg: Pg, count: number): void {
    this.#kycRequired.set({ pg }, count);
  }

  pgBalanceDiff(pg: Pg, pgStore: PgStore, diff: number): void {
    this.#balanceDiff.set({ pg, store: pgStore }, diff);
  }

  payoutOverdue(pg: Pg): void {
    this.#overdue.inc({ pg });
  }
}
