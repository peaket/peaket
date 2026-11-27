// F-04-19 연구 내보내기 HTTP(동결 로컬, LCH-330).
// 정본: docs/features/forensic-replay.md §6.1·§6.3·§6.4·§8(FX-T10·T17·T21), docs/api/openapi.yaml 태그 ops.
import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  CreateOpsResearchExportResponse,
  GetOpsResearchExportParams,
  GetOpsResearchExportResponse,
} from '@peaket/contracts/openapi/ops';
import { ContractParams, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, Idempotent, ProblemError, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ResearchExports, ResearchProblem } from '../application/research-exports.js';
import type { ResearchActor } from '../domain/research-export.js';

const RESEARCH_MEDIA_TYPE = 'application/vnd.apache.arrow.file';
/** 시간창은 서비스가 422로 가른다. 계약 스키마의 min(0)보다 넓게 받아 음수·30분 초과를 422로 남긴다. */
const ResearchBody = z
  .object({
    eventId: z.string(),
    fromMs: z.int(),
    toMs: z.int(),
    reason: z.string().min(1).max(500),
  })
  .strict();
const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined);

const actorOf = (me: Principal): ResearchActor => ({
  accountId: me.accountId,
  sessionId: me.sessionId,
  role: me.role ?? '',
  designations: [],
});

/** `about:blank`처럼 케밥이 아닌 Problem 이름도 그대로 내기 위한 좁은 예외. */
class BareResearchProblem extends ProblemError {
  constructor(type: string, status: number, title: string) {
    super({ type: 'research-export', status, title });
    Object.defineProperty(this, 'type', { value: type, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(this, 'slug', { value: type, enumerable: true, configurable: true, writable: true });
  }
}

const reject = (e: unknown, reply?: FastifyReply): never => {
  if (e instanceof ResearchProblem) {
    if (reply && e.retryAfter !== undefined) reply.header('Retry-After', String(e.retryAfter));
    throw new BareResearchProblem(e.type, e.status, e.message);
  }
  throw e;
};

@Controller('v1/ops/research-exports')
export class ResearchExportsController {
  constructor(private readonly exports: ResearchExports) {}

  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @Roles(['commander'])
  @Idempotent({ operation: 'CREATE_RESEARCH_EXPORT' })
  @ContractRouteSchema({ responses: { 202: CreateOpsResearchExportResponse } })
  async create(
    @Body() raw: unknown,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      const parsed = ResearchBody.safeParse(raw);
      if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
      const body = parsed.data;
      const record = await this.exports.request(actorOf(me), body, { key: idem.key, requestHash: idem.requestHash });
      return {
        exportId: record.exportId,
        eventId: record.eventId,
        status: record.status,
        createdAt: new Date(record.createdAtMs).toISOString(),
      };
    } catch (e) {
      reject(e, reply);
    }
  }

  @Get(':exportId')
  @Header('Cache-Control', 'no-store')
  @Roles(['commander'])
  @ContractRouteSchema({ params: GetOpsResearchExportParams, responses: { 200: GetOpsResearchExportResponse } })
  async receive(
    @ContractParams(GetOpsResearchExportParams) params: { exportId: string },
    @CurrentPrincipal() me: Principal,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      const { bytes } = await this.exports.receive(actorOf(me), params.exportId, {
        mode: one(headers['sec-fetch-mode']),
        site: one(headers['sec-fetch-site']),
      });
      void reply.header('Content-Type', RESEARCH_MEDIA_TYPE).header('Cache-Control', 'no-store').send(Buffer.from(bytes));
    } catch (e) {
      reject(e, reply);
    }
  }
}
