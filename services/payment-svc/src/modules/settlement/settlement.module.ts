// settlement 모듈 조립. 저장소·결제 원장·지급 어댑터·재인증 확인을 밖에서 받는다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, CLOCK } from '@peaket/platform';
import { Settlements } from './application/settlements.js';
import type { PayoutGateway, ReauthVerifier, SettlementPaymentSource, SettlementStore } from './domain/ports.js';
import { PAYOUT_GATEWAY, REAUTH_VERIFIER, SETTLEMENT_PAYMENT_SOURCE, SETTLEMENT_STORE } from './domain/ports.js';
import { PartnerSettlementController } from './inbound/partner-settlement.controller.js';

export interface SettlementModuleDeps {
  readonly store: SettlementStore;
  readonly payments: SettlementPaymentSource;
  readonly gateways: readonly PayoutGateway[];
  readonly reauth: ReauthVerifier;
  readonly commissionRateBp?: number;
}

@Module({})
export class SettlementModule {
  static register(deps: SettlementModuleDeps): DynamicModule {
    const providers: Provider[] = [
      { provide: SETTLEMENT_STORE, useValue: deps.store },
      { provide: SETTLEMENT_PAYMENT_SOURCE, useValue: deps.payments },
      { provide: PAYOUT_GATEWAY, useValue: deps.gateways },
      { provide: REAUTH_VERIFIER, useValue: deps.reauth },
      {
        provide: Settlements,
        useFactory: (store: SettlementStore, payments: SettlementPaymentSource, gateways: readonly PayoutGateway[], reauth: ReauthVerifier, clock: Clock) =>
          new Settlements({ store, payments, gateways, reauth, clock, ...(deps.commissionRateBp !== undefined ? { commissionRateBp: deps.commissionRateBp } : {}) }),
        inject: [SETTLEMENT_STORE, SETTLEMENT_PAYMENT_SOURCE, PAYOUT_GATEWAY, REAUTH_VERIFIER, CLOCK],
      },
    ];
    return { module: SettlementModule, controllers: [PartnerSettlementController], providers };
  }
}
