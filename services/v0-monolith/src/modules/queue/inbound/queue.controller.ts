// 받는 층: 대기열 v0 HTTP(docs/features/queue-admission.md §13). 사람은 게이트웨이가 넘긴 pid로만 고른다(경로에 사람 ID 없음).
import { Controller, Delete, ForbiddenException, Get, HttpCode, Post } from '@nestjs/common';
import { ContractParams, CurrentPrincipal, LogPolicy, type Principal, Roles, requestLog } from '@peaket/platform';
import { z } from 'zod';
import { QueueService } from '../application/queue-service.js';
import { EVENT_ID_PATTERN } from '../domain/queue.js';

const EventParams = z.object({ eventId: z.string().regex(EVENT_ID_PATTERN) }).strict();
type EventParams = z.output<typeof EventParams>;

/** NFR-001 진입 p99 200ms(비교용으로 v1과 같은 값을 쓴다) */
const ENTRY_SLO_MS = 200;

function pidOf(me: Principal): string {
  // ticket:buy는 본인확인을 마친 계정이라 pid가 있어야 한다. 없으면 게이트웨이 신원 머리가 덜 왔다
  if (!me.pid) throw new ForbiddenException();
  return me.pid;
}

@Controller('v1/queues/:eventId')
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  @Post('entries')
  @HttpCode(201)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @LogPolicy({ entry: true, sloLatencyMs: ENTRY_SLO_MS })
  async enter(@ContractParams(EventParams) p: EventParams, @CurrentPrincipal() me: Principal) {
    requestLog().set({ queuePhase: 'waiting' });
    return this.queue.enter(p.eventId, pidOf(me));
  }

  @Get('entries/me')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @LogPolicy({ sloLatencyMs: ENTRY_SLO_MS })
  async status(@ContractParams(EventParams) p: EventParams, @CurrentPrincipal() me: Principal) {
    requestLog().set({ queuePhase: 'waiting' });
    return this.queue.status(p.eventId, pidOf(me));
  }

  @Delete('entries/me')
  @HttpCode(204)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  async cancel(@ContractParams(EventParams) p: EventParams, @CurrentPrincipal() me: Principal): Promise<void> {
    requestLog().set({ queuePhase: 'waiting' });
    await this.queue.cancel(p.eventId, pidOf(me));
  }

  @Post('admission')
  @HttpCode(200)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  async admit(@ContractParams(EventParams) p: EventParams, @CurrentPrincipal() me: Principal) {
    requestLog().set({ queuePhase: 'waiting' });
    return this.queue.admit(p.eventId, pidOf(me));
  }
}
