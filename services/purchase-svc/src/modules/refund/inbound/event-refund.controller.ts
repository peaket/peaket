// purchase-svc 내부 HTTP: ops-svc가 회차 취소 미리보기·시작·진행률·일시정지·재개·연기 신청·창 닫기를 부른다(BAT-425).
// 공개 계약은 docs/api/proto/peaket/purchase/v1/refund.proto(EventRefundService)이고, gRPC가 정본이다.
// 이 HTTP는 같은 쓰임새를 여는 호환 경로다(구버전 ops-svc·로컬·CI). 두 길은 같은 EventRefundService와 멱등 키를 쓴다.
// 클러스터 안에서만 열고, 인증은 서비스 메시/네트워크 정책 몫이다(공개 경로 아님).
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ContractRouteSchema, InternalTokenGuard, Roles } from '@peaket/platform';
import { z } from 'zod';
import { EventRefundError, EventRefundService } from '../application/event-refund-service.js';
import {
  EVENT_REFUND_FAULTS,
  EVENT_REFUND_KINDS,
  EVENT_REFUND_STATUSES,
  REFUND_JOB_STATES,
  REFUND_PAUSE_REASONS,
  REFUND_PG_PROVIDERS,
} from '../domain/event-refund.js';

const PreviewBody = z.object({ eventId: z.uuid(), fault: z.enum(EVENT_REFUND_FAULTS) }).strict();
const StartBody = z
  .object({
    eventId: z.uuid(),
    requestId: z.uuid(),
    fault: z.enum(EVENT_REFUND_FAULTS),
    ruledBy: z.string().min(1),
    confirmedBy: z.string().min(1),
    fanNoticeReason: z.string().max(200).optional(),
    kind: z.enum(EVENT_REFUND_KINDS).optional(),
    postponedToMs: z.number().int().positive().optional(),
    refundWindowClosesAtMs: z.number().int().positive().optional(),
  })
  .strict();
const PauseBody = z.object({ pg: z.enum(REFUND_PG_PROVIDERS).optional(), reason: z.string().min(1) }).strict();
const ResumeBody = z.object({ pg: z.enum(REFUND_PG_PROVIDERS).optional(), reason: z.string().max(200).optional() }).strict();
const ApplyBody = z.object({ ticketId: z.uuid(), applicationId: z.uuid().optional(), appliedAtMs: z.number().int().positive().optional() }).strict();
const CloseWindowBody = z.object({ closedBy: z.string().min(1), reason: z.string().min(1) }).strict();
const PreviewView = z.object({
  targetOrders: z.number().int(),
  refundTotal: z.number().int(),
  compensationTargets: z.number().int(),
  compensationTotal: z.number().int(),
  perPg: z.array(z.object({ pg: z.enum(REFUND_PG_PROVIDERS), orders: z.number().int(), estimatedSeconds: z.number().int() })),
});
const ProgressView = z.object({
  total: z.number().int(),
  done: z.number().int(),
  failed: z.number().int(),
  notApplied: z.number().int(),
  perPg: z.array(
    z.object({
      pg: z.enum(REFUND_PG_PROVIDERS),
      state: z.enum(REFUND_JOB_STATES),
      pauseReason: z.enum(REFUND_PAUSE_REASONS).optional(),
      done: z.number().int(),
      failed: z.number().int(),
      unknown: z.number().int(),
      notApplied: z.number().int(),
    }),
  ),
});
const RequestView = z.object({
  requestId: z.uuid(),
  eventId: z.uuid(),
  kind: z.enum(EVENT_REFUND_KINDS),
  status: z.enum(EVENT_REFUND_STATUSES),
  fault: z.enum(EVENT_REFUND_FAULTS).optional(),
  fanNoticeReason: z.string().optional(),
  postponedToMs: z.number().int().optional(),
  refundWindowClosesAtMs: z.number().int().optional(),
  targetOrders: z.number().int(),
  refundTotal: z.number().int(),
  compensationTargets: z.number().int(),
  compensationTotal: z.number().int(),
  progress: ProgressView,
  ruledBy: z.string().optional(),
  confirmedBy: z.string().optional(),
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
});

const fail = (err: unknown): never => {
  if (err instanceof EventRefundError) {
    if (err.code === 'INVALID') throw new BadRequestException(err.message);
    if (err.code === 'NOT_FOUND') throw new NotFoundException(err.message);
    throw new ConflictException(err.message);
  }
  throw err;
};

@Controller('internal/v1/event-refunds')
@Roles(['public'])
@UseGuards(InternalTokenGuard)
export class EventRefundController {
  constructor(private readonly service: EventRefundService) {}

  @Post('preview')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: PreviewView } })
  async preview(@Body() body: unknown) {
    const parsed = PreviewBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('미리보기 본문이 올바르지 않습니다');
    try {
      return await this.service.preview(parsed.data);
    } catch (err) {
      return fail(err);
    }
  }

  @Post()
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: RequestView } })
  async start(@Body() body: unknown) {
    const parsed = StartBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('회차 취소 시작 본문이 올바르지 않습니다');
    try {
      return await this.service.start(parsed.data);
    } catch (err) {
      return fail(err);
    }
  }

  @Get(':requestId')
  @ContractRouteSchema({ responses: { 200: RequestView } })
  async get(@Param('requestId') requestId: string) {
    try {
      return await this.service.get(requestId);
    } catch (err) {
      return fail(err);
    }
  }

  @Post(':requestId/pauses')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: RequestView } })
  async pause(@Param('requestId') requestId: string, @Body() body: unknown) {
    const parsed = PauseBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('일시정지 본문이 올바르지 않습니다');
    try {
      return await this.service.pause({ requestId, ...parsed.data });
    } catch (err) {
      return fail(err);
    }
  }

  @Post(':requestId/resumptions')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: RequestView } })
  async resume(@Param('requestId') requestId: string, @Body() body: unknown) {
    const parsed = ResumeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('재개 본문이 올바르지 않습니다');
    try {
      return await this.service.resume({ requestId, ...parsed.data });
    } catch (err) {
      return fail(err);
    }
  }

  @Post(':requestId/applications')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: RequestView } })
  async apply(@Param('requestId') requestId: string, @Body() body: unknown) {
    const parsed = ApplyBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('환급 신청 본문이 올바르지 않습니다');
    try {
      return await this.service.apply({ requestId, ...parsed.data });
    } catch (err) {
      return fail(err);
    }
  }

  @Post(':requestId/window-closures')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: RequestView } })
  async closeWindow(@Param('requestId') requestId: string, @Body() body: unknown) {
    const parsed = CloseWindowBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('신청 창 닫기 본문이 올바르지 않습니다');
    try {
      return await this.service.closeWindow({ requestId, ...parsed.data });
    } catch (err) {
      return fail(err);
    }
  }
}
