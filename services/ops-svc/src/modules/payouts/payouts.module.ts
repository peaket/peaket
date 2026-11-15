// 지급 승인 업무 모듈 조립.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK, INTERNAL_TOKEN } from '@peaket/platform';
import type { AuditChain } from '../audit/audit.js';
import { PayoutApprovals } from './application/payout-approvals.js';
import { APPROVAL_REAUTH_VERIFIER, PAYOUT_APPROVAL_STORE, PAYOUT_PAYMENT_CLIENT, type ApprovalReauthVerifier, type PayoutApprovalStore, type PayoutPaymentClient } from './domain/ports.js';
import { DrizzlePayoutApprovalStore } from './adapters/db/drizzle-store.js';
import { MemoryPayoutApprovalStore } from './adapters/memory-store.js';
import { UnavailableApprovalVerifier } from './adapters/jwks-approval-verifier.js';
import { UnavailablePayoutPaymentClient } from './adapters/payment-http.js';
import { PayoutsController } from './inbound/payouts.controller.js';

export interface PayoutsModuleDeps {
  readonly store?: PayoutApprovalStore;
  readonly payments: PayoutPaymentClient;
  readonly reauth?: ApprovalReauthVerifier;
  /** 지급 승인 요청·승인·반려·실행·재시도를 감사 체인에 남긴다 */
  readonly audit?: AuditChain;
}

@Module({})
export class PayoutsModule {
  static register(o: { storage: 'memory'; deps?: Partial<PayoutsModuleDeps> } | ({ storage: 'database'; database: Database } & PayoutsModuleDeps)): DynamicModule {
    const providers: Provider[] = [
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      {
        provide: PayoutApprovals,
        useFactory: (store: PayoutApprovalStore, payments: PayoutPaymentClient, reauth: ApprovalReauthVerifier, clock: Clock) =>
          new PayoutApprovals({ store, payments, reauth, clock, ...((o.storage === 'database' ? o.audit : o.deps?.audit) ? { audit: o.storage === 'database' ? o.audit! : o.deps!.audit! } : {}) }),
        inject: [PAYOUT_APPROVAL_STORE, PAYOUT_PAYMENT_CLIENT, APPROVAL_REAUTH_VERIFIER, CLOCK],
      },
    ];
    if (o.storage === 'database') {
      return {
        module: PayoutsModule,
        controllers: [PayoutsController],
        providers: [
          ...providers,
          { provide: PAYOUT_APPROVAL_STORE, useValue: o.store ?? new DrizzlePayoutApprovalStore(o.database) },
          { provide: PAYOUT_PAYMENT_CLIENT, useValue: o.payments },
          { provide: APPROVAL_REAUTH_VERIFIER, useValue: o.reauth ?? new UnavailableApprovalVerifier() },
        ],
      };
    }
    return {
      module: PayoutsModule,
      controllers: [PayoutsController],
      providers: [
        ...providers,
        { provide: PAYOUT_APPROVAL_STORE, useValue: o.deps?.store ?? new MemoryPayoutApprovalStore() },
        { provide: PAYOUT_PAYMENT_CLIENT, useValue: o.deps?.payments ?? new UnavailablePayoutPaymentClient() },
        { provide: APPROVAL_REAUTH_VERIFIER, useValue: o.deps?.reauth ?? new UnavailableApprovalVerifier() },
      ],
    };
  }
}
