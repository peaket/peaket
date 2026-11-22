// F-07-5 정산 이의 기각·수기 조정 승인 시험의 공용 조립(LCH-100, ADR-0368 결정 6~8).
// payment-svc 내부 HTTP 경계는 포트 SettlementPaymentClient의 짝 가짜로 끼운다(진짜 HTTP 어댑터는 각 시험이 전역 fetch 대역으로 따로 본다).
import 'reflect-metadata';
import { createService, fakeClock, ProblemError } from '@peaket/platform';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { MemorySettlementAdjustmentApprovalStore } from '../src/modules/approvals/index.js';
import { UnavailablePayoutPaymentClient, type ApprovalReauthVerifier, type SettlementAdjustmentRow, type SettlementPaymentClient } from '../src/modules/payouts/index.js';
import { FakeIdentity, quiet } from './support.js';

/**
 * payment-svc가 기각 응답으로 주는 정산서 보기(payment `statementView`의 칸 전부). ops가 CS 역할에게 넘길 칸만 골라야 하므로
 * 결제사·계좌·묶음 칸까지 실제와 같은 모양으로 둔다(리뷰 RV-03).
 */
export const paymentStatementView = (statementId: string) => ({
  statementId,
  kind: 'EVENT',
  eventId: '0194c000-0000-7000-8000-0000000e0001',
  pg: 'TOSS',
  pgStore: 'STANDARD',
  periodStart: null,
  periodEnd: null,
  grossAmount: 30_000_000,
  refundAmount: 2_000_000,
  commissionAmount: 2_800_000,
  commissionVat: 280_000,
  offsetAmount: 0,
  payoutAmount: 24_920_000,
  revision: 1,
  supersedesId: null,
  excludedPayments: ['0194c000-0000-7000-8000-0000000a0001:RECONCILIATION_MISMATCH'],
  status: 'NOTIFIED',
  holdReason: null,
  disputeDueAt: '2026-11-20T06:00:00.000Z',
  payoutDate: '2026-11-27',
  payoutBankCode: '004',
  payoutAccountLast4: '1234',
  payoutBatchId: null,
});

type Row = 'PENDING' | 'APPLIED' | 'VOID';

/**
 * payment-svc 정산 내부 경로의 짝 가짜. 조정 행 상태(PENDING·APPLIED·VOID)를 payment와 같은 규칙으로 기억한다:
 * 적용은 한 번만 효과가 있고(재적용은 처음 결과), 적용된 행의 void는 409 settlement-adjustment-applied다.
 */
export class FakeSettlementPayments implements SettlementPaymentClient {
  readonly dismissed: { statementId: string; reason: string; actorId: string }[] = [];
  readonly registered: { statementId: string; input: Parameters<SettlementPaymentClient['registerAdjustment']>[1] }[] = [];
  readonly applied: string[] = [];
  readonly voided: string[] = [];
  readonly rows = new Map<string, Row>();
  /** 실제로 조정 합계를 바꾼 횟수(승인 ID별) */
  readonly effects = new Map<string, number>();
  /** 다음 호출에 던질 오류(한 번). apply는 적용하지 않고 던진다 */
  failNext: { dismiss?: ProblemError; register?: ProblemError; apply?: ProblemError; void?: ProblemError } = {};
  /** 다음 적용은 커밋한 뒤 응답이 끊긴다(적용하고 503을 던진다, 리뷰 RV-04) */
  loseNextApplyResponse = false;
  /** 적용 중에 부를 갈고리(payment가 ops 승인 기록을 읽는 자리) */
  onApply: ((approvalId: string) => Promise<void>) | undefined;

  async dismissDispute(statementId: string, input: { reason: string; actorId: string }): Promise<unknown> {
    const e = this.failNext.dismiss;
    this.failNext.dismiss = undefined;
    if (e) throw e;
    this.dismissed.push({ statementId, ...input });
    return paymentStatementView(statementId);
  }

  async registerAdjustment(statementId: string, input: Parameters<SettlementPaymentClient['registerAdjustment']>[1]): Promise<SettlementAdjustmentRow> {
    const e = this.failNext.register;
    this.failNext.register = undefined;
    if (e) throw e;
    this.registered.push({ statementId, input: { ...input } });
    if (!this.rows.has(input.approvalId)) this.rows.set(input.approvalId, 'PENDING');
    return { adjustmentId: `adj-${input.approvalId}`, statementId, approvalId: input.approvalId, reasonCode: input.reasonCode, disputeId: input.disputeId ?? null, amount: input.amount, status: 'PENDING' };
  }

  async applyAdjustment(approvalId: string): Promise<unknown> {
    await this.onApply?.(approvalId);
    const e = this.failNext.apply;
    this.failNext.apply = undefined;
    if (e) throw e;
    const row = this.rows.get(approvalId) ?? 'PENDING';
    if (row === 'VOID') throw new ProblemError({ type: 'settlement-adjustment-void', status: 409, title: '반려·만료된 조정입니다' });
    if (row === 'PENDING') {
      this.rows.set(approvalId, 'APPLIED');
      this.effects.set(approvalId, (this.effects.get(approvalId) ?? 0) + 1);
    }
    this.applied.push(approvalId);
    if (this.loseNextApplyResponse) {
      this.loseNextApplyResponse = false;
      throw new ProblemError({ type: 'settlement-dependency-unavailable', status: 503, title: '정산 서비스에 연결하지 못했습니다' });
    }
    return { adjustment: { approvalId, status: 'APPLIED' } };
  }

  async voidAdjustment(approvalId: string): Promise<unknown> {
    const e = this.failNext.void;
    this.failNext.void = undefined;
    if (e) throw e;
    this.voided.push(approvalId);
    if (this.rows.get(approvalId) === 'APPLIED') throw new ProblemError({ type: 'settlement-adjustment-applied', status: 409, title: '이미 적용한 조정입니다' });
    this.rows.set(approvalId, 'VOID');
    return { approvalId, status: 'VOID' };
  }
}

/** 재인증 경계의 짝 가짜(ApprovalReauthVerifier). 정한 토큰과 세션-계정 짝만 받는다 */
export class TestReauth implements ApprovalReauthVerifier {
  readonly accountOf = new Map<string, string>();
  async verify(token: string | undefined, o: { sessionId: string; act: string }) {
    if (o.act !== 'APPROVAL' || token !== 'approval-token') throw new ProblemError({ type: 'reauth-required', status: 403, title: '다시 인증해 주세요' });
    return { accountId: this.accountOf.get(o.sessionId) ?? '', factors: ['password', 'totp', 'passkey'] };
  }
}

export type OpsRole = 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead';

export async function opsSettlementFlow(now: number) {
  const identity = new FakeIdentity();
  const audit = new MemoryAuditChain();
  const payments = new FakeSettlementPayments();
  const reauth = new TestReauth();
  const store = new MemorySettlementAdjustmentApprovalStore(audit);
  const svc = await createService({
    name: 'ops-svc-settlement',
    module: AppModule.register({
      memory: true,
      auditChain: audit,
      payouts: { payments: new UnavailablePayoutPaymentClient(), settlementPayments: payments, reauth },
      approvals: { reauth, settlementAdjustmentStore: store },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const headers = (role: OpsRole, o: { reauth?: boolean; idempotencyKey?: string; json?: boolean } = {}): Record<string, string> => {
    const h = identity.ops(role);
    if (o.reauth) reauth.accountOf.set(h['x-session-id']!, h['x-user-id']!);
    return { ...h, ...(o.json === false ? {} : { 'content-type': 'application/json' }), ...(o.reauth ? { 'x-reauth-token': 'approval-token' } : {}), ...(o.idempotencyKey ? { 'idempotency-key': o.idempotencyKey } : {}) };
  };
  return { svc, identity, audit, payments, reauth, store, headers, close: () => svc.close() };
}

export type OpsSettlementFlow = Awaited<ReturnType<typeof opsSettlementFlow>>;
