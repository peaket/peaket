// 정산 지급 지표 다섯(F-07-6 LCH-110, settlement §11, ADR-0369 결정 12)과 F-07-7의 계좌 변경·포트원 사후 대사·ops 받기 거절 지표(계획 §5.1 (사)·(파) (다)(마)). PromPaymentWebhookSignals와 같은 꼴이다:
// 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다. 경보 규칙·대시보드 패널은 정리 목록 C-04다.
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { OpsIntakeTarget, SettlementSignals } from '../domain/ports.js';
import type { Pg, PgStore } from '../domain/settlement.js';

const FAILURE_CLASSES = ['ACCOUNT', 'TRANSIENT', 'LIMIT_KYC', 'UNKNOWN'] as const;
const CHANGE_RESULTS = ['ACCEPTED', 'HOLDER_MISMATCH', 'AGENCY_FAILED'] as const;
const OPS_TARGETS: readonly OpsIntakeTarget[] = ['cs-case', 'ops-alert', 'audit-record'];

export class PromSettlementSignals implements SettlementSignals {
  readonly #failed = new Counter({ name: 'settlement_payout_failed_total', help: '지급 건 실패 반영 수(결제사·실패 갈래)', labelNames: ['pg', 'reason'] as const, registers: [] });
  readonly #signatureInvalid = new Counter({ name: 'settlement_webhook_signature_invalid_total', help: '서명이 맞지 않아 거절한 정산 웹훅 수', registers: [] });
  readonly #kycRequired = new Gauge({ name: 'settlement_seller_kyc_required', help: '지금 KYC_REQUIRED인 셀러 수(결제사)', labelNames: ['pg'] as const, registers: [] });
  readonly #balanceDiff = new Gauge({ name: 'settlement_pg_balance_diff_krw', help: '마지막 결제사 잔액 대사의 차이(보이는 잔액 − 있어야 할 잔액, 원)', labelNames: ['pg', 'store'] as const, registers: [] });
  readonly #overdue = new Counter({ name: 'settlement_payout_overdue_total', help: '지급일 다음 영업일 12시까지 끝나지 않은 지급 건 수(결제사)', labelNames: ['pg'] as const, registers: [] });
  readonly #accountChange = new Counter({ name: 'settlement_payout_account_change_total', help: '정산 계좌 변경 시도 수(결과)', labelNames: ['result'] as const, registers: [] });
  readonly #agencySyncPending = new Gauge({ name: 'settlement_payout_agency_sync_pending', help: '결제사 수정 대기 중인 정산 계좌 수', registers: [] });
  readonly #withdrawalUnmatched = new Counter({ name: 'settlement_portone_withdrawal_unmatched_total', help: '포트원 출금 대사에서 맞지 않거나 이어지지 않거나 없는 출금 수', registers: [] });
  readonly #partnerAccountMismatch = new Gauge({ name: 'settlement_portone_partner_account_mismatch', help: '포트원 파트너 계좌가 PEAKET 기록과 다른 파트너 수', registers: [] });
  readonly #portoneBalanceDiff = new Gauge({ name: 'settlement_portone_balance_diff_krw', help: '포트원 잔액의 operator 입력값과 이체 원장 계산값의 차이(원)', registers: [] });
  readonly #ledgerSyncAge = new Gauge({ name: 'settlement_portone_ledger_sync_age_seconds', help: '포트원 사후 대사의 마지막 성공 뒤 지난 초(대사 종류)', labelNames: ['sync'] as const, registers: [] });
  readonly #executionPending = new Gauge({ name: 'settlement_portone_execution_pending', help: '지급일 15시에 일괄 지급 ID가 없는 그날 포트원 지급 묶음 수', registers: [] });
  readonly #opsRefused = new Counter({ name: 'settlement_ops_intake_refused_total', help: 'ops 받기가 거절한 수(202 accepted false·400·422, 대상)', labelNames: ['target'] as const, registers: [] });
  readonly #opsFailed = new Gauge({ name: 'settlement_ops_intake_failed', help: '거절 3번으로 영구 실패한 채 남은 행 수(대상)', labelNames: ['target'] as const, registers: [] });

  constructor() {
    // 처음 일어나기 전에도 경보식이 값을 보게 토스 이름표를 0으로 미리 보인다
    for (const reason of FAILURE_CLASSES) this.#failed.inc({ pg: 'TOSS', reason }, 0);
    this.#signatureInvalid.inc(0);
    this.#overdue.inc({ pg: 'TOSS' }, 0);
    for (const result of CHANGE_RESULTS) this.#accountChange.inc({ result }, 0);
    this.#withdrawalUnmatched.inc(0);
    for (const target of OPS_TARGETS) {
      this.#opsRefused.inc({ target }, 0);
      this.#opsFailed.set({ target }, 0);
    }
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    for (const m of [
      this.#failed,
      this.#signatureInvalid,
      this.#kycRequired,
      this.#balanceDiff,
      this.#overdue,
      this.#accountChange,
      this.#agencySyncPending,
      this.#withdrawalUnmatched,
      this.#partnerAccountMismatch,
      this.#portoneBalanceDiff,
      this.#ledgerSyncAge,
      this.#executionPending,
      this.#opsRefused,
      this.#opsFailed,
    ])
      registry.registerMetric(m);
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

  payoutAccountChange(result: 'ACCEPTED' | 'HOLDER_MISMATCH' | 'AGENCY_FAILED'): void {
    this.#accountChange.inc({ result });
  }

  agencySyncPending(count: number): void {
    this.#agencySyncPending.set(count);
  }

  portoneWithdrawalUnmatched(): void {
    this.#withdrawalUnmatched.inc();
  }

  portonePartnerAccountMismatch(count: number): void {
    this.#partnerAccountMismatch.set(count);
  }

  portoneBalanceDiff(diff: number): void {
    this.#portoneBalanceDiff.set(diff);
  }

  portoneLedgerSyncAge(sync: 'WITHDRAWAL' | 'PARTNER_ACCOUNT', seconds: number): void {
    this.#ledgerSyncAge.set({ sync }, seconds);
  }

  portoneExecutionPending(count: number): void {
    this.#executionPending.set(count);
  }

  opsIntakeRefused(target: OpsIntakeTarget): void {
    this.#opsRefused.inc({ target });
  }

  opsIntakeFailed(target: OpsIntakeTarget, count: number): void {
    this.#opsFailed.set({ target }, count);
  }
}
