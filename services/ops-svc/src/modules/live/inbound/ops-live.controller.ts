// 관제 늘 여는 SSE 흐름 GET /v1/ops/live(BAT-465 R-584, openapi /v1/ops/live, ADR-0100).
// 1초 [가정]마다 명령 원장·감사 체크포인트에서 바뀐 것을 읽어 command·audit 사건으로 내보내고, 15초마다 주석 줄을 쓴다.
// 다시 붙을 때 Last-Event-ID 뒤를 다시 보내고, 1시간 [가정]보다 오래됐으면 reset을 보낸다(화면은 REST로 다시 읽는다).
// gw-ops는 이 경로의 시간 초과를 꺼야 한다(openapi 설명).
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { CLOCK, type Clock, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { checkpointViewOf, type AuditCheckpoint } from '../../audit/index.js';
import { baseViewOf, type Command } from '../../commands/index.js';
import { OpsLiveFeed } from '../application/ops-live-feed.js';
import { OPS_LIVE_HEARTBEAT_MS, OPS_LIVE_SCAN_MS, SSE_HEARTBEAT, formatSse, lastEventIdOf, type OpsLiveEvent } from '../domain/live.js';

/** 사건 값을 화면 모양으로 바꾼다(명령은 목록과 같은 모양, 감사는 체크포인트 모양) */
export function liveDataOf(e: OpsLiveEvent, me?: Principal): unknown {
  if (e.event === 'command') return baseViewOf(e.data as Command, me);
  if (e.event === 'audit') return checkpointViewOf(e.data as AuditCheckpoint);
  return e.data;
}

@Controller('v1/ops/live')
export class OpsLiveController {
  constructor(
    private readonly feed: OpsLiveFeed,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @Roles(['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'])
  @ContractRouteSchema({ responses: { 200: z.string() } })
  async stream(@Req() request: FastifyRequest, @Res() reply: FastifyReply, @CurrentPrincipal() me: Principal): Promise<void> {
    const header = request.headers['last-event-id'];
    const last = lastEventIdOf(typeof header === 'string' ? header : undefined, this.clock.now());
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    let lastId = last.kind === 'since' ? last.sinceMs : this.clock.now();
    const write = (chunk: string): void => {
      if (!closed) reply.raw.write(chunk);
    };
    if (last.kind === 'reset') write(formatSse({ id: lastId, event: 'reset', data: { reason: last.reason } }));
    // 첫 연결에는 지금 값을 보낸다(화면이 빈 목록으로 시작하지 않게). 다시 붙으면 그 뒤만 보낸다.
    if (last.kind === 'none') lastId = 0;

    let scanning = false;
    const scan = async (): Promise<void> => {
      if (closed || scanning) return;
      scanning = true;
      try {
        const events = await this.feed.scan(lastId);
        for (const e of events) {
          write(formatSse({ ...e, data: liveDataOf(e, me) }));
          if (e.id > lastId) lastId = e.id;
        }
      } catch {
        // 읽기 실패는 다음 주기에 다시 한다(흐름을 닫지 않는다)
      } finally {
        scanning = false;
      }
    };

    const scanTimer = setInterval(() => void scan(), OPS_LIVE_SCAN_MS);
    const heartbeat = setInterval(() => write(SSE_HEARTBEAT), OPS_LIVE_HEARTBEAT_MS);
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(scanTimer);
      clearInterval(heartbeat);
      reply.raw.end();
    };
    request.raw.on('close', close);
    request.raw.on('error', close);
    void scan();
  }
}
