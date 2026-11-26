// F-04-14 외부 되팔이 게시물 API(openapi 태그 investigations, FR-072).
// 등록은 multipart/form-data이고 쿠키 인증 쓰기라 X-Requested-With를 요구한다. 서버는 게시물 주소를 부르지 않는다.
import { Controller, Get, Header, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import {
  CreateOpsExternalPostResponse,
  GetOpsExternalPostCaptureParams,
  ListOpsExternalPostsResponse,
} from '@peaket/contracts/openapi/investigations';
import { AcceptMultipart, ContractParams, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, Idempotent, ProblemError, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { OPS_ROLES, type AdminRole } from '../../admin-accounts/index.js';
import { ExternalPosts } from '../application/fraud-evidence.js';
import { bareProblem } from '../application/bare-problem.js';
import { maskRegionsOf, readEvidenceUploadForm, requireXRequestedWith } from './evidence-multipart.js';

const reject = (e: unknown): never => {
  if (e instanceof ProblemError) throw e;
  if (e && typeof e === 'object' && 'type' in e && 'status' in e) {
    const p = e as { type: string; status: number; message?: string; title?: string };
    throw bareProblem(p.type, p.status, p.message ?? p.title ?? p.type);
  }
  throw e;
};

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined);
const actorOf = (me: Principal) => ({ accountId: me.accountId, role: me.role ?? 'viewer' });

@Controller('v1/ops')
export class ExternalPostsController {
  constructor(private readonly posts: ExternalPosts) {}

  @Post('external-posts')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @AcceptMultipart({
    maxBytes: 10 * 1024 * 1024 + 64 * 1024,
    tooLarge: () => bareProblem('external-post-capture-too-large', 413, '화면 캡처는 10MB까지 올릴 수 있습니다'),
    bulkhead: { name: 'ops-external-post', limit: 8, retryAfterSeconds: 1 },
  })
  @Idempotent({ operation: 'CREATE_EXTERNAL_POST' })
  @ContractRouteSchema({ responses: { 201: CreateOpsExternalPostResponse } })
  async register(
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) _reply: FastifyReply,
  ) {
    try {
      requireXRequestedWith(request);
      const form = await readEvidenceUploadForm(request);
      const field = (name: string): string | undefined => form.fields.get(name)?.[0];
      const eventId = field('eventId');
      const url = field('url');
      const capturedAt = field('capturedAt');
      const source = field('source');
      if (!eventId || !url || !capturedAt || (source !== 'REPORT' && source !== 'MANUAL')) throw bareProblem('invalid-body', 400, '필수 칸이 빠졌습니다');
      const capture = form.files.find((f) => f.field === 'capture');
      if (!capture) throw bareProblem('invalid-body', 400, '캡처 파일이 없습니다');
      const capturedAtMs = Date.parse(capturedAt);
      if (!Number.isFinite(capturedAtMs)) throw bareProblem('invalid-body', 400, '수집 시각이 올바르지 않습니다');
      const postedAt = field('postedAt');
      const postedAtMs = postedAt === undefined ? undefined : Date.parse(postedAt);
      if (postedAtMs !== undefined && !Number.isFinite(postedAtMs)) throw bareProblem('invalid-body', 400, '게시 시각이 올바르지 않습니다');
      const maskRegions = maskRegionsOf(form.fields.get('maskRegions') ?? []);
      return await this.posts.register(actorOf(me), idem, {
        eventId,
        url,
        capturedAtMs,
        source,
        ...(field('reportCaseId') ? { reportCaseId: field('reportCaseId')! } : {}),
        ...(field('claimedSeats') ? { claimedSeats: field('claimedSeats')! } : {}),
        ...(postedAtMs !== undefined ? { postedAtMs } : {}),
        ...(maskRegions.length > 0 ? { maskRegions } : {}),
        capture: { name: capture.name, bytes: capture.bytes },
      });
    } catch (e) {
      reject(e);
    }
  }

  @Get('external-posts')
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @ContractRouteSchema({ responses: { 200: ListOpsExternalPostsResponse } })
  async list(@Query() q: Record<string, string | string[] | undefined>, @CurrentPrincipal() me: Principal) {
    try {
      const eventId = one(q.eventId);
      if (!eventId) throw bareProblem('invalid-query', 400, 'eventId가 필요합니다');
      return await this.posts.list(actorOf(me), { eventId, ...(one(q.cursor) ? { cursor: one(q.cursor)! } : {}), limit: one(q.limit) ? Math.min(100, Math.max(1, Number(one(q.limit)))) : 50 });
    } catch (e) {
      reject(e);
    }
  }

  @Get('external-posts/:postId/capture')
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @ContractRouteSchema({ params: GetOpsExternalPostCaptureParams, responses: {} })
  async capture(@ContractParams(GetOpsExternalPostCaptureParams) params: { postId: string }, @CurrentPrincipal() me: Principal, @Res() reply: FastifyReply) {
    try {
      const out = await this.posts.view(actorOf(me), params.postId);
      void reply.header('cache-control', 'no-store').type('image/png').send(Buffer.from(out.bytes));
    } catch (e) {
      reject(e);
    }
  }
}
