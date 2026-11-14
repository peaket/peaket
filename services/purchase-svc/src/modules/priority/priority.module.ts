// 우선 구매 모듈(GAT-135). 저장소·좌석·취소표 읽기를 AppModule/start가 골라 넘긴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock, INTERNAL_TOKEN, InternalTokenGuard } from '@peaket/platform';
import type { SeatMap } from '../inventory/index.js';
import { GrantPriorityPurchase } from './application/grant-priority-purchase.js';
import { WithdrawPriorityGrant } from './application/withdraw-priority-grant.js';
import type { CancelledTickets, PriorityGrantStore, PrioritySeatCandidates, PrioritySeatHolds } from './domain/ports.js';
import { PriorityGrantController } from './inbound/priority-grant.controller.js';

export const PRIORITY_GRANTS = Symbol('purchase.PRIORITY_GRANTS');
export const PRIORITY_CANCELLED_TICKETS = Symbol('purchase.PRIORITY_CANCELLED_TICKETS');
export const PRIORITY_SEAT_HOLDS = Symbol('purchase.PRIORITY_SEAT_HOLDS');
export const PRIORITY_SEAT_CANDIDATES = Symbol('purchase.PRIORITY_SEAT_CANDIDATES');
export const PRIORITY_SEAT_MAP = Symbol('purchase.PRIORITY_SEAT_MAP');

export interface PriorityModuleDeps {
  readonly grants: PriorityGrantStore;
  readonly cancelled: CancelledTickets;
  readonly seats: PrioritySeatHolds;
  readonly candidates: PrioritySeatCandidates;
  readonly seatMap: Pick<SeatMap, 'resolve'>;
}

@Module({})
export class PriorityModule {
  static register(deps: PriorityModuleDeps): DynamicModule {
    const providers: Provider[] = [
      { provide: PRIORITY_GRANTS, useValue: deps.grants },
      { provide: PRIORITY_CANCELLED_TICKETS, useValue: deps.cancelled },
      { provide: PRIORITY_SEAT_HOLDS, useValue: deps.seats },
      { provide: PRIORITY_SEAT_CANDIDATES, useValue: deps.candidates },
      { provide: PRIORITY_SEAT_MAP, useValue: deps.seatMap },
      {
        provide: GrantPriorityPurchase,
        useFactory: (clock: Clock) => new GrantPriorityPurchase({ ...deps, clock }),
        inject: [CLOCK],
      },
      {
        provide: WithdrawPriorityGrant,
        useFactory: (clock: Clock) => new WithdrawPriorityGrant(deps.grants, () => clock.now()),
        inject: [CLOCK],
      },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      InternalTokenGuard,
    ];
    return { module: PriorityModule, controllers: [PriorityGrantController], providers };
  }
}
