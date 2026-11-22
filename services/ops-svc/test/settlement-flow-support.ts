// F-07-5 정산 이의 기각·수기 조정 승인 시험의 공용 조립(LCH-100, ADR-0368 결정 6~8).
// payment-svc 내부 HTTP 경계는 포트 SettlementPaymentClient의 짝 가짜로 끼운다(진짜 HTTP 어댑터는 각 시험이 전역 fetch 대역으로 따로 본다).
import 'reflect-metadata';
import { createService, fakeClock, ProblemError } from '@peaket/platform';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { MemorySettlementAdjustmentApprovalStore } from '../src/modules/approvals/index.js';
import { UnavailablePayoutPaymentClient, type ApprovalReauthVerifier, type SettlementAdjustmentRow, type SettlementPaymentClient } from '../src/modules/payouts/index.js';
import { FakeIdentity, quiet } from './support.js';

/** payment-svc 정산 내부 경로의 짝 가짜. 등록한 조정 행을 기억하고, 실패를 정해 줄 수 있다 */
export class FakeSettlementPayments implements SettlementPaymentClient {
  readonly dismissed: { statementId: string; reason: string; actorId: string }[] = [];
  readonly registered: { statementId: string; input: Parameters<SettlementPaymentClient['registerAdjustment']>[1] }[] = [];
  readonly applied: string[] = [];
  readonly voided: string[] = [];
  /** 다음 호출에 던질 오류(한 번) */
  failNext: { dismiss?: ProblemError; register?: ProblemError; apply?: ProblemError } = {};
  /** 적용 중에 부를 갈고리(payment가 ops 승인 기록을 읽는 자리) */
  onApply: ((approvalId: string) => Promise<void>) | undefined;

  async dismissDispute(statementId: string, input: { reason: string; actorId: string }): Promise<unknown> {
    const e = this.failNext.dismiss;
    this.failNext.dismiss = undefined;
    if (e) throw e;
    this.dismissed.push({ statementId, ...input });
    return { statementId, status: 'NOTIFIED' };
  }

  async registerAdjustment(statementId: string, input: Parameters<SettlementPaymentClient['registerAdjustment']>[1]): Promise<SettlementAdjustmentRow> {
    const e = this.failNext.register;
    this.failNext.register = undefined;
    if (e) throw e;
    this.registered.push({ statementId, input: { ...input } });
    return { adjustmentId: `adj-${input.approvalId}`, statementId, approvalId: input.approvalId, reasonCode: input.reasonCode, disputeId: input.disputeId ?? null, amount: input.amount, status: 'PENDING' };
  }

  async applyAdjustment(approvalId: string): Promise<unknown> {
    await this.onApply?.(approvalId);
    const e = this.failNext.apply;
    this.failNext.apply = undefined;
    if (e) throw e;
    this.applied.push(approvalId);
    return { adjustment: { approvalId, status: 'APPLIED' } };
  }

  async voidAdjustment(approvalId: string): Promise<unknown> {
    this.voided.push(approvalId);
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
