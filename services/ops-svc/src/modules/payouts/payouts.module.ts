// 지�??�인 ?�무 모듈 조립.
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK, INTERNAL_TOKEN } from '@peaket/platform';
import type { AuditChain } from '../audit/audit.js';
import type { ApprovalFailureCases } from '../cases/index.js';
import { PayoutApprovals } from './application/payout-approvals.js';
import {
  APPROVAL_REAUTH_VERIFIER,
  isSettlementPaymentClient,
  PAYOUT_APPROVAL_STORE,
  PAYOUT_PAYMENT_CLIENT,
  SETTLEMENT_PAYMENT_CLIENT,
  type ApprovalReauthVerifier,
  type PayoutApprovalStore,
  type PayoutPaymentClient,
  type SettlementPaymentClient,
} from './domain/ports.js';
import { DrizzlePayoutApprovalStore } from './adapters/db/drizzle-store.js';
import { MemoryPayoutApprovalStore } from './adapters/memory-store.js';
import { UnavailableApprovalVerifier } from './adapters/jwks-approval-verifier.js';
import { UnavailablePayoutPaymentClient } from './adapters/payment-http.js';
import { InternalPayoutApprovalsController } from './inbound/internal-payout-approvals.controller.js';
import { PayoutsController } from './inbound/payouts.controller.js';

export interface PayoutsModuleDeps {
  readonly store?: PayoutApprovalStore;
  readonly payments: PayoutPaymentClient;
  readonly reauth?: ApprovalReauthVerifier;
  /** payment-svc 정산서 이의 기각·수기 조정 경로. 없으면 payments가 그 경로도 가지면 그것을, 아니면 503 대역을 쓴다 */
  readonly settlementPayments?: SettlementPaymentClient;
  /** ?�기 ?�트???�행 감사(OPSV-03). ?�태 ?�??감사???�?�소가 같�? ?�랜??��???�다 */
  readonly audit?: AuditChain;
  /** CS '승인 업무 실행 실패' 건(F-06-2 ADR-0364 결정 6) */
  readonly failureCases?: ApprovalFailureCases;
}

@Global()
@Module({})
export class PayoutsModule {
  static register(
    o:
      | { storage: 'memory'; deps?: Partial<PayoutsModuleDeps>; audit?: AuditChain }
      | ({ storage: 'database'; database: Database } & PayoutsModuleDeps),
  ): DynamicModule {
    const payments = o.storage === 'database' ? o.payments : o.deps?.payments;
    const settlementPayments = (o.storage === 'database' ? o.settlementPayments : o.deps?.settlementPayments) ?? (isSettlementPaymentClient(payments) ? payments : new UnavailablePayoutPaymentClient());
    const providers: Provider[] = [
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      { provide: SETTLEMENT_PAYMENT_CLIENT, useValue: settlementPayments },
      {
        provide: PayoutApprovals,
        useFactory: (store: PayoutApprovalStore, payments: PayoutPaymentClient, reauth: ApprovalReauthVerifier, clock: Clock, settlements: SettlementPaymentClient) =>
          new PayoutApprovals({
            store,
            payments,
            reauth,
            clock,
            settlements,
            ...((o.storage === 'database' ? o.audit : o.deps?.audit) ? { audit: o.storage === 'database' ? o.audit! : o.deps!.audit! } : {}),
            ...((o.storage === 'database' ? o.failureCases : o.deps?.failureCases) ? { failureCases: o.storage === 'database' ? o.failureCases! : o.deps!.failureCases! } : {}),
          }),
        inject: [PAYOUT_APPROVAL_STORE, PAYOUT_PAYMENT_CLIENT, APPROVAL_REAUTH_VERIFIER, CLOCK, SETTLEMENT_PAYMENT_CLIENT],
      },
    ];
    if (o.storage === 'database') {
      return {
        module: PayoutsModule,
        global: true,
        controllers: [PayoutsController, InternalPayoutApprovalsController],
        providers: [
          ...providers,
          { provide: PAYOUT_APPROVAL_STORE, useValue: o.store ?? new DrizzlePayoutApprovalStore(o.database) },
          { provide: PAYOUT_PAYMENT_CLIENT, useValue: o.payments },
          { provide: APPROVAL_REAUTH_VERIFIER, useValue: o.reauth ?? new UnavailableApprovalVerifier() },
        ],
        exports: [PayoutApprovals, SETTLEMENT_PAYMENT_CLIENT],
      };
    }
    return {
      module: PayoutsModule,
      global: true,
      controllers: [PayoutsController, InternalPayoutApprovalsController],
      providers: [
        ...providers,
        { provide: PAYOUT_APPROVAL_STORE, useValue: o.deps?.store ?? new MemoryPayoutApprovalStore(o.audit) },
        { provide: PAYOUT_PAYMENT_CLIENT, useValue: o.deps?.payments ?? new UnavailablePayoutPaymentClient() },
        { provide: APPROVAL_REAUTH_VERIFIER, useValue: o.deps?.reauth ?? new UnavailableApprovalVerifier() },
      ],
      exports: [PayoutApprovals, SETTLEMENT_PAYMENT_CLIENT],
    };
  }
}
