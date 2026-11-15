// 지급 승인 업무 모듈 조립.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK, INTERNAL_TOKEN } from '@peaket/platform';
import { PayoutApprovals } from './application/payout-approvals.js';
import { APPROVAL_REAUTH_VERIFIER, PAYOUT_APPROVAL_STORE, PAYOUT_AUDIT_CHAIN, PAYOUT_PAYMENT_CLIENT, type ApprovalReauthVerifier, type PayoutApprovalStore, type PayoutAuditChain, type PayoutPaymentClient } from './domain/ports.js';
import { DrizzlePayoutApprovalStore } from './adapters/db/drizzle-store.js';
import { MemoryPayoutApprovalStore } from './adapters/memory-store.js';
import { UnavailableApprovalVerifier } from './adapters/jwks-approval-verifier.js';
import { UnavailablePayoutPaymentClient } from './adapters/payment-http.js';
import { PayoutsController } from './inbound/payouts.controller.js';

export interface PayoutsModuleDeps {
  readonly store?: PayoutApprovalStore;
  readonly payments: PayoutPaymentClient;
  readonly reauth?: ApprovalReauthVerifier;
  readonly audit?: PayoutAuditChain;
}

@Module({})
export class PayoutsModule {
  static register(o: { storage: 'memory'; deps?: Partial<PayoutsModuleDeps> } | ({ storage: 'database'; database: Database } & PayoutsModuleDeps)): DynamicModule {
    const providers: Provider[] = [
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      {
        provide: PayoutApprovals,
        useFactory: (store: PayoutApprovalStore, payments: PayoutPaymentClient, reauth: ApprovalReauthVerifier, audit: PayoutAuditChain | undefined, clock: Clock) =>
          new PayoutApprovals({ store, payments, reauth, ...(audit ? { audit } : {}), clock }),
        inject: [PAYOUT_APPROVAL_STORE, PAYOUT_PAYMENT_CLIENT, APPROVAL_REAUTH_VERIFIER, PAYOUT_AUDIT_CHAIN, CLOCK],
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
          { provide: PAYOUT_AUDIT_CHAIN, useValue: o.audit },
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
        { provide: PAYOUT_AUDIT_CHAIN, useValue: o.deps?.audit },
      ],
    };
  }
}
