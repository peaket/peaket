// 관제 늘 여는 SSE 흐름 GET /v1/ops/live(openapi /v1/ops/live, asyncapi sse.ops-live, ADR-0100 결정 1·2·4, ADR-0360).
// 파드의 알림 표 읽기(PushHub)가 0.5초 [가정]마다 새 행을 모든 연결에 나눠 주고, 연결마다 역할·요청자로 거른다.
// - Last-Event-ID가 없으면 지금 정한 번호부터(첫 덩이에 id만 둔다). 있으면 그 뒤를 표에서 다시 보낸다
// - 1시간 [가정] 밖·지운 번호면 reset(too-old), 숫자가 아니거나 만든 적 없는 번호면 reset(invalid). reset의 id는 지금 번호라 다시 reset되지 않는다
// - eventId를 주면 그 회차의 접속자(presence)를 보내고 이 연결을 접속자 표에 15초 [가정]마다 적는다
// gw-ops는 이 경로의 시간 초과를 끈다(timeouts.request 0s).
import { Controller, Get, Inject, Optional, Req, Res } from '@nestjs/common';
import { CLOCK, type Clock, ContractRouteSchema, CurrentPrincipal, PLATFORM_LOGGER, type PlatformLogger, type Principal, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OPS_LIVE_REPLAY_WINDOW_MS, lastEventIdOf, resumeVerdictOf, type OpsLiveEvent } from '../domain/live.js';
import type { PushEventSource } from '../domain/ports.js';
import { OpsLiveFeed, type PushDelivery } from '../application/ops-live-feed.js';
import { PresenceHub } from '../application/presence.js';
import { PushHub } from '../application/push-hub.js';
import { PUSH_EVENT_SOURCE, TERMINATED_SESSIONS } from '../tokens.js';
import { SseConnection, type TerminatedSessionsView } from './sse-connection.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCREEN = /^[a-z][a-z0-9-]{0,39}$/;

/** 쿼리(eventId는 접속자를 보일 회차, screen은 보고 있는 화면) */
export const OpsLiveQuery = z.object({
  eventId: z.string().regex(UUID).optional(),
  screen: z.string().regex(SCREEN).optional(),
});

@Controller('v1/ops/live')
export class OpsLiveController {
  constructor(
    private readonly feed: OpsLiveFeed,
    private readonly hub: PushHub,
    private readonly presence: PresenceHub,
    @Inject(PUSH_EVENT_SOURCE) private readonly source: PushEventSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(TERMINATED_SESSIONS) private readonly terminated?: TerminatedSessionsView,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  @Get()
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ query: OpsLiveQuery, responses: { 200: z.string() } })
  async stream(@Req() request: FastifyRequest, @Res() reply: FastifyReply, @CurrentPrincipal() me: Principal): Promise<void> {
    const q = OpsLiveQuery.safeParse(request.query ?? {});
    const query = q.success ? q.data : {};
    const header = request.headers['last-event-id'];
    const last = lastEventIdOf(typeof header === 'string' ? header : undefined);
    const conn = new SseConnection(request, reply, {
      stream: 'ops-live',
      me,
      nowMs: this.clock.now(),
      ...(this.terminated ? { terminated: this.terminated } : {}),
      ...(this.logger ? { logger: this.logger } : {}),
    });

    let settled = 0;
    try {
      await this.hub.ready();
      settled = this.hub.settled;
    } catch {
      // 알림 표를 못 읽으면 지금부터(0) 연다. 허브가 다음 주기에 다시 잡는다
    }

    // 다시 붙기 판정
    let cursor = settled;
    let reset: 'too-old' | 'invalid' | undefined = last.kind === 'reset' ? last.reason : undefined;
    if (last.kind === 'since') {
      try {
        const [latest, oldest] = await Promise.all([this.source.latest(), this.source.oldestWithin(OPS_LIVE_REPLAY_WINDOW_MS)]);
        const verdict = resumeVerdictOf(last.seq, latest, oldest);
        if (verdict === 'ok') cursor = last.seq;
        else reset = verdict;
      } catch {
        reset = 'too-old';
      }
    }

    // 허브의 새 행은 다시 보내기가 끝날 때까지 모아 둔다(겹침은 보낸 번호로 지운다)
    let lastSent = cursor;
    let replaying = true;
    const held: PushDelivery[] = [];
    const deliver = (batch: readonly PushDelivery[]): void => {
      for (const d of batch) {
        if (d.row.seq <= lastSent) continue;
        lastSent = d.row.seq;
        const e = this.feed.eventFor(d, me);
        if (e) conn.send(e);
      }
    };
    const unsubscribe = this.hub.subscribe((batch) => {
      if (replaying) held.push(...batch);
      else deliver(batch);
    });
    conn.onClose(unsubscribe);

    conn.open(last.kind === 'since' && !reset ? undefined : settled);
    if (reset) {
      const e: OpsLiveEvent = { id: settled, event: 'reset', data: { reason: reset } };
      conn.send(e);
      lastSent = settled;
    } else if (cursor < settled) {
      try {
        deliver(await this.hub.replay(cursor, settled));
      } catch {
        // 다시 보내기를 못 하면 reset으로 화면이 REST를 다시 읽게 한다
        conn.send({ id: settled, event: 'reset', data: { reason: 'too-old' } });
        lastSent = Math.max(lastSent, settled);
      }
    }
    replaying = false;
    deliver(held.splice(0));

    if (query.eventId && me?.accountId && UUID.test(me.accountId) && me.role) {
      const stop = this.presence.watch(query.eventId, { accountRef: me.accountId, role: me.role, screen: query.screen ?? 'console' }, (s) => conn.send({ event: 'presence', data: s }));
      conn.onClose(stop);
    }
  }
}
