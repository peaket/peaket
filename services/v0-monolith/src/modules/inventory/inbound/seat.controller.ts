// 받는 층: 좌석 v0 HTTP(docs/features/seat-hold.md §14 동작 1~4). 사람은 게이트웨이가 넘긴 계정·pid로만 고른다.
import { Controller, Delete, ForbiddenException, Get, HttpCode, Post } from '@nestjs/common';
import { ContractBody, ContractParams, CurrentPrincipal, LogPolicy, type Principal, Roles, requestLog } from '@peaket/platform';
import { z } from 'zod';
import { InventoryService, type Requester } from '../application/inventory-service.js';
import { EVENT_ID_PATTERN, MAX_SEATS_PER_HOLD, SEAT_ID_PATTERN } from '../domain/inventory.js';

const EventParams = z.object({ eventId: z.string().regex(EVENT_ID_PATTERN) }).strict();
type EventParams = z.output<typeof EventParams>;
const HoldParams = z.object({ holdId: z.uuid() }).strict();
type HoldParams = z.output<typeof HoldParams>;
const HoldBody = z.object({ seatIds: z.array(z.string().regex(SEAT_ID_PATTERN)).min(1).max(MAX_SEATS_PER_HOLD) }).strict();
type HoldBody = z.output<typeof HoldBody>;

/** NFR-003 홀드 p99 50ms(비교용으로 v1과 같은 값) */
const HOLD_SLO_MS = 50;

function requester(me: Principal): Requester {
  // ticket:buy는 본인확인을 마친 계정이라 pid가 있어야 한다. 없으면 게이트웨이 신원 머리가 덜 왔다
  if (!me.pid) throw new ForbiddenException();
  return { accountId: me.accountId, pid: me.pid };
}

/** 좌석 목록은 v0에만 있어 /v0/ 아래에 둔다(/v1/은 openapi 계약의 경로만, docs/features/seat-hold.md §14 동작 1) */
@Controller('v0/events/:eventId')
export class SeatListController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('seats')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  async seats(@ContractParams(EventParams) p: EventParams, @CurrentPrincipal() me: Principal) {
    requestLog().set({ queuePhase: 'purchase' });
    return this.inventory.seats(p.eventId, requester(me));
  }
}

@Controller('v1/events/:eventId')
export class SeatController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('holds')
  @HttpCode(201)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @LogPolicy({ sloLatencyMs: HOLD_SLO_MS })
  async hold(@ContractParams(EventParams) p: EventParams, @ContractBody(HoldBody) body: HoldBody, @CurrentPrincipal() me: Principal) {
    requestLog().set({ queuePhase: 'purchase' });
    return this.inventory.hold(p.eventId, requester(me), body.seatIds);
  }
}

@Controller('v1/holds/:holdId')
export class HoldController {
  constructor(private readonly inventory: InventoryService) {}

  @Delete()
  @HttpCode(204)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  async release(@ContractParams(HoldParams) p: HoldParams, @CurrentPrincipal() me: Principal): Promise<void> {
    requestLog().set({ queuePhase: 'purchase' });
    await this.inventory.release(p.holdId, requester(me));
  }

  @Post('extension')
  @HttpCode(200)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  async extend(@ContractParams(HoldParams) p: HoldParams, @CurrentPrincipal() me: Principal) {
    requestLog().set({ queuePhase: 'purchase' });
    return this.inventory.extend(p.holdId, requester(me));
  }
}
