// settlement 모듈 조립. 저장소·결제 원장·지급 어댑터·재인증 확인을 밖에서 받는다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, CLOCK, INTERNAL_TOKEN } from '@peaket/platform';
import { Settlements } from './application/settlements.js';
import type { DueEventSettlementSource, EventCommissionRateSource, PayoutApprovalVerifier, PayoutGateway, ProductSettlementSource, ReauthVerifier, SaleSuspensionSource, SettlementApprovalLog, SettlementPaymentSource, SettlementStore } from './domain/ports.js';
import {
  PAYOUT_APPROVAL_VERIFIER,
  PAYOUT_GATEWAY,
  REAUTH_VERIFIER,
  SALE_SUSPENSION_SOURCE,
  SETTLEMENT_APPROVAL_LOG,
  SETTLEMENT_COMMISSION_SOURCE,
  SETTLEMENT_EVENT_SOURCE,
  SETTLEMENT_PAYMENT_SOURCE,
  SETTLEMENT_PRODUCT_SOURCE,
  SETTLEMENT_STORE,
} from './domain/ports.js';
import { PartnerSettlementController } from './inbound/partner-settlement.controller.js';
import { InternalSettlementController } from './inbound/internal-settlement.controller.js';

export interface SettlementModuleDeps {
  readonly store: SettlementStore;
  readonly payments: SettlementPaymentSource;
  readonly products?: ProductSettlementSource;
  readonly events?: DueEventSettlementSource;
  readonly eventCommission?: EventCommissionRateSource;
  readonly approvals: PayoutApprovalVerifier;
  readonly saleSuspensions: SaleSuspensionSource;
  readonly gateways: readonly PayoutGateway[];
  readonly reauth: ReauthVerifier;
  readonly commissionRateBp?: number;
  readonly log?: SettlementApprovalLog;
}

@Module({})
export class SettlementModule {
  static register(deps: SettlementModuleDeps): DynamicModule {
    const providers: Provider[] = [
      { provide: SETTLEMENT_STORE, useValue: deps.store },
      { provide: SETTLEMENT_PAYMENT_SOURCE, useValue: deps.payments },
      { provide: SETTLEMENT_PRODUCT_SOURCE, useValue: deps.products },
      { provide: SETTLEMENT_EVENT_SOURCE, useValue: deps.events },
      { provide: SETTLEMENT_COMMISSION_SOURCE, useValue: deps.eventCommission },
      { provide: PAYOUT_APPROVAL_VERIFIER, useValue: deps.approvals },
      { provide: SALE_SUSPENSION_SOURCE, useValue: deps.saleSuspensions },
      { provide: SETTLEMENT_APPROVAL_LOG, useValue: deps.log },
      { provide: PAYOUT_GATEWAY, useValue: deps.gateways },
      { provide: REAUTH_VERIFIER, useValue: deps.reauth },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      {
        provide: Settlements,
        useFactory: (
          store: SettlementStore,
          payments: SettlementPaymentSource,
          products: ProductSettlementSource | undefined,
          events: DueEventSettlementSource | undefined,
          eventCommission: EventCommissionRateSource | undefined,
          approvals: PayoutApprovalVerifier,
          saleSuspensions: SaleSuspensionSource,
          log: SettlementApprovalLog | undefined,
          gateways: readonly PayoutGateway[],
          reauth: ReauthVerifier,
          clock: Clock,
        ) =>
          new Settlements({
            store,
            payments,
            ...(products ? { products } : {}),
            ...(events ? { events } : {}),
            ...(eventCommission ? { eventCommission } : {}),
            approvals,
            saleSuspensions,
            ...(log ? { log } : {}),
            gateways,
            reauth,
            clock,
            ...(deps.commissionRateBp !== undefined ? { commissionRateBp: deps.commissionRateBp } : {}),
          }),
        inject: [
          SETTLEMENT_STORE,
          SETTLEMENT_PAYMENT_SOURCE,
          SETTLEMENT_PRODUCT_SOURCE,
          SETTLEMENT_EVENT_SOURCE,
          SETTLEMENT_COMMISSION_SOURCE,
          PAYOUT_APPROVAL_VERIFIER,
          SALE_SUSPENSION_SOURCE,
          SETTLEMENT_APPROVAL_LOG,
          PAYOUT_GATEWAY,
          REAUTH_VERIFIER,
          CLOCK,
        ],
      },
    ];
    return { module: SettlementModule, controllers: [PartnerSettlementController, InternalSettlementController], providers };
  }
}
