// 대사 지표(docs/observability.md 같은 줄, BUILD_ORDER HOT-153). PromPaymentWebhookSignals와 같은 꼴이다: 지표는 registers: []로 만들고 register(registry)로 프로세스 레지스트리에 붙인다.
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { PgName } from '../domain/payment-gateway.js';
import type { PaymentReconciliationSignals } from '../domain/ports.js';
import type { ReconDiffKind } from '../domain/reconciliation.js';

/**
 * - payment_reconciliation_runs_total{pg, result}: 실행 끝 수(done·failed)
 * - payment_reconciliation_last_transactions·last_mismatches·last_duration_seconds·last_throughput_per_second{pg}: 마지막 실행의 값
 * - payment_reconciliation_mismatches_total{pg, kind}: 처음 쓴 불일치 수
 * - payment_reconciliation_overdue_dates{pg}: 되돌아보는 기간을 넘겨 끝내지 못한 날 수
 */
export class PromPaymentReconciliationSignals implements PaymentReconciliationSignals {
  readonly #runs = new Counter({ name: 'payment_reconciliation_runs_total', help: '대사 실행이 끝난 수', labelNames: ['pg', 'result'] as const, registers: [] });
  readonly #transactions = new Gauge({ name: 'payment_reconciliation_last_transactions', help: '마지막 대사 실행의 거래 수', labelNames: ['pg'] as const, registers: [] });
  readonly #mismatches = new Gauge({ name: 'payment_reconciliation_last_mismatches', help: '마지막 대사 실행의 불일치 수', labelNames: ['pg'] as const, registers: [] });
  readonly #seconds = new Gauge({ name: 'payment_reconciliation_last_duration_seconds', help: '마지막 대사 실행의 소요(초)', labelNames: ['pg'] as const, registers: [] });
  readonly #perSecond = new Gauge({ name: 'payment_reconciliation_last_throughput_per_second', help: '마지막 대사 실행의 처리량(초당 건수)', labelNames: ['pg'] as const, registers: [] });
  readonly #mismatchTotal = new Counter({ name: 'payment_reconciliation_mismatches_total', help: '대사에서 처음 쓴 불일치 수(종류별)', labelNames: ['pg', 'kind'] as const, registers: [] });
  readonly #overdueDates = new Gauge({ name: 'payment_reconciliation_overdue_dates', help: '되돌아보는 기간을 넘겨 대사를 끝내지 못한 날 수(0보다 크면 SEV2)', labelNames: ['pg'] as const, registers: [] });

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#runs);
    registry.registerMetric(this.#transactions);
    registry.registerMetric(this.#mismatches);
    registry.registerMetric(this.#seconds);
    registry.registerMetric(this.#perSecond);
    registry.registerMetric(this.#mismatchTotal);
    registry.registerMetric(this.#overdueDates);
    return this;
  }

  run(pg: PgName, result: 'done' | 'failed'): void {
    this.#runs.inc({ pg, result });
  }

  lastRun(pg: PgName, v: { readonly transactions: number; readonly mismatches: number; readonly seconds: number; readonly perSecond: number }): void {
    this.#transactions.set({ pg }, v.transactions);
    this.#mismatches.set({ pg }, v.mismatches);
    this.#seconds.set({ pg }, v.seconds);
    this.#perSecond.set({ pg }, v.perSecond);
  }

  mismatch(pg: PgName, kind: ReconDiffKind): void {
    this.#mismatchTotal.inc({ pg, kind });
  }

  overdueDates(pg: PgName, count: number): void {
    this.#overdueDates.set({ pg }, count);
  }
}
