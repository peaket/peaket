// 받는 층: CS 처리함 목록·상세·갱신(openapi listOpsCases·getOpsCase·updateOpsCase, gw-ops /v1/ops/cases*, F-06-2 GAT-280, ADR-0364 결정 5).
// 역할은 platform RolesGuard가 identity GetAdminAuthz로 판정한다(operator·commander·cs_agent·cs_lead, viewer는 403). 건 종류와 역할의 재판정은 CsCases가 한다.
// 단건 GET·PATCH 200은 ETag(판 번호)를 싣고, PATCH는 If-Match를 읽는다(없으면 428, 다르면 412, docs/api/guidelines.md '동시 수정').
// 응답은 Cache-Control: no-store다(가린 값과 처리 메모가 공용 캐시에 남지 않게).
// 추가 검증 이의 인정·기각(F-06-7, openapi createOpsCaseVerificationAppealDecision): 경로 역할은 넷이고(operator·commander가 403 case-update-not-allowed를 받게)
// 결정은 CS 담당자만 한다. Idempotency-Key(@Idempotent)·If-Match를 읽고 202에 해결한 새 판의 ETag를 싣는다.
import { Body, Controller, Get, Header, Headers, HttpCode, Optional, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { CreateOpsCaseVerificationAppealDecisionResponse, GetOpsCaseResponse, ListOpsCasesResponse, UpdateOpsCaseResponse } from '@peaket/contracts/openapi/ops';
import { ContractRouteSchema, CurrentPrincipal, Idempotent, IdempotencyRequest, ProblemError, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CsCases } from '../application/cs-cases.js';
import { ApprovalLifecycle } from '../../approvals/index.js';
import { DECIDE_VERIFICATION_APPEAL, VerificationAppealDecision } from '../application/verification-appeal-decision.js';
import { CS_CASE_STATUSES } from '../domain/cs-case.js';

const CASE_ROLES = ['operator', 'commander', 'cs_agent', 'cs_lead'] as const;
/**
 * 갱신 본문(openapi updateOpsCase). 배정 풀기는 null이고 빈 글은 400 invalid-body다(리뷰 RV-02).
 * 메모 글자 수(코드 포인트 2,000)는 CsCases가 서버 셈으로 다시 보고 넘으면 400 invalid-body다
 */
const UpdateBody = z
  .object({
    assignee: z.string().min(1).max(64).nullable().optional(),
    status: z.enum(CS_CASE_STATUSES).optional(),
    resultNote: z.string().max(4_000).optional(),
  })
  .strict();

/**
 * 이의 결정 본문(openapi createOpsCaseVerificationAppealDecision). 받는 층은 모양과 4,000자 상한만 보고,
 * 메모 2,000자(코드 포인트)·빈 메모는 받는 차례 끝에서 VerificationAppealDecision이 본다(bot-defense §12 '메모 길이')
 */
const DecisionBody = z
  .object({
    outcome: z.enum(['ACCEPTED', 'REJECTED']),
    resultNote: z.string().max(4_000).optional(),
  })
  .strict();

const CancellationDecisionBody = z.object({ decision: z.enum(['VOID', 'REFUND']), reason: z.string().min(1).max(2_000) }).strict();
const SystemRefundBody = z.object({ reason: z.string().min(1).max(2_000) }).strict();

const etagOf = (version: number): string => `"${version}"`;
const actorOf = (me: Principal) => ({ accountId: me.accountId, role: me.role ?? 'viewer' });
const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

@Controller('v1/ops/cases')
export class OpsCasesController {
  constructor(
    private readonly cases: CsCases,
    private readonly decision: VerificationAppealDecision,
    @Optional() private readonly approvalLifecycle?: ApprovalLifecycle,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Roles([...CASE_ROLES])
  @ContractRouteSchema({ responses: { 200: ListOpsCasesResponse } })
  async list(@Query() q: Record<string, string | string[] | undefined>, @CurrentPrincipal() me: Principal) {
    return this.cases.list(actorOf(me), { kind: one(q.kind), status: one(q.status), dueWithinDays: one(q.dueWithinDays), cursor: one(q.cursor), limit: one(q.limit) });
  }

  @Get(':caseId')
  @Header('Cache-Control', 'no-store')
  @Roles([...CASE_ROLES])
  @ContractRouteSchema({ responses: { 200: GetOpsCaseResponse } })
  async get(@Param('caseId') caseId: string, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    const out = await this.cases.get(actorOf(me), caseId);
    void reply.header('etag', etagOf(out.version));
    return out.view;
  }

  @Patch(':caseId')
  @Header('Cache-Control', 'no-store')
  @Roles([...CASE_ROLES])
  @ContractRouteSchema({ responses: { 200: UpdateOpsCaseResponse } })
  async update(
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @CurrentPrincipal() me: Principal,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = UpdateBody.safeParse(body ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    const out = await this.cases.update(actorOf(me), caseId, one(headers['if-match']), parsed.data);
    void reply.header('etag', etagOf(out.version));
    return out.view;
  }

  @Post(':caseId/verification-appeal-decision')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @Roles([...CASE_ROLES])
  @Idempotent({ operation: DECIDE_VERIFICATION_APPEAL })
  @ContractRouteSchema({ responses: { 202: CreateOpsCaseVerificationAppealDecisionResponse } })
  async decide(
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @CurrentPrincipal() me: Principal,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @IdempotencyRequest() idem: IdempotencyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const parsed = DecisionBody.safeParse(body ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    const out = await this.decision.handle(actorOf(me), caseId, one(headers['if-match']), idem, parsed.data);
    void reply.header('etag', etagOf(out.version));
    return out.view;
  }
  /** GAT-300 FLAGGED 취소 무효(VOID)/환급(REFUND) 결정(F-06-3 IR-11). cs_lead만. */
  @Post(':caseId/cancellation-decision')
  @HttpCode(200)
  @Roles(['cs_lead'])
  @ContractRouteSchema({ responses: { 200: z.record(z.string(), z.unknown()) } })
  async cancellationDecision(@Param('caseId') caseId: string, @Body() body: unknown, @CurrentPrincipal() me: Principal) {
    const parsed = CancellationDecisionBody.safeParse(body ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    const before = await this.cases.get(actorOf(me), caseId);
    if (before.view.kind !== 'FLAGGED') throw new ProblemError({ type: 'case-not-flagged', status: 409, title: '이상 표시 건이 아닙니다' });
    if (!this.approvalLifecycle) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '승인 업무 연결을 사용할 수 없습니다' });
    // FLAGGED 건의 대상은 취소 ID다. purchase basis가 주문 ID와 남은 환급액을 돌려준다(IR-11)
    const basis = await this.approvalLifecycle.refundBasis(before.view.targetRef);
    if (!basis) throw new ProblemError({ type: 'not-found', status: 404, title: '승인 대상을 찾지 못했습니다' });
    if (parsed.data.decision === 'VOID') {
      // 취소 무효는 입장 기록이 있어야 한다(계획 §4.1). 없으면 ticket-svc를 부르지 않는다(IR-30)
      if (!basis.entryRecorded) throw new ProblemError({ type: 'case-entry-record-missing', status: 409, title: '입장 기록이 없어 취소를 무효로 할 수 없습니다' });
      const out = await this.approvalLifecycle.voidOrder(basis.orderId, 'FLAGGED_VOID', { ...(basis.issueGeneration !== undefined ? { issueGeneration: basis.issueGeneration } : {}), ...(basis.eventId !== undefined ? { eventId: basis.eventId } : {}) });
      if (out.alreadyEntered === 0) throw new ProblemError({ type: 'case-entry-record-missing', status: 409, title: '입장 기록이 없어 취소를 무효로 할 수 없습니다' });
      if (basis.orderId !== before.view.targetRef) await this.approvalLifecycle.voidCancellation(before.view.targetRef);
    }
    if (parsed.data.decision === 'REFUND') {
      if (basis.refundableAmount <= 0) throw new ProblemError({ type: 'case-nothing-to-refund', status: 409, title: '환급할 남은 금액이 없습니다' });
      await this.approvalLifecycle.request({ kind: 'SYSTEM_FAULT_REFUND', targetRef: basis.orderId, amount: basis.refundableAmount, reasonCode: 'FLAGGED_REFUND', reasonText: parsed.data.reason }, { ...actorOf(me), role: 'cs_agent', sessionId: 'case-action' });
    }
    await this.cases.resolveAsSystem(caseId, `cancellation-decision:${parsed.data.decision}:${parsed.data.reason}`, Date.now(), me.accountId);
    const after = await this.cases.get(actorOf(me), caseId);
    return after.view;
  }

  /** GAT-300 TICKET_NOT_ISSUED의 시스템 잘못 환불 승인 업무(F-06-3 IR-11). cs_lead만. */
  @Post(':caseId/system-refund')
  @HttpCode(201)
  @Roles(['cs_lead'])
  @ContractRouteSchema({ responses: { 201: z.record(z.string(), z.unknown()) } })
  async systemRefund(@Param('caseId') caseId: string, @Body() body: unknown, @CurrentPrincipal() me: Principal) {
    const parsed = SystemRefundBody.safeParse(body ?? {});
    if (!parsed.success) throw new ProblemError({ type: 'invalid-body', status: 400, title: '요청 본문이 올바르지 않습니다' });
    const before = await this.cases.get(actorOf(me), caseId);
    if (before.view.kind !== 'TICKET_NOT_ISSUED') throw new ProblemError({ type: 'case-not-refundable', status: 409, title: '미발권 건이 아닙니다' });
    if (!this.approvalLifecycle) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '승인 업무 연결을 사용할 수 없습니다' });
    const basis = await this.approvalLifecycle.refundBasis(before.view.targetRef);
    if (!basis) throw new ProblemError({ type: 'not-found', status: 404, title: '승인 대상을 찾지 못했습니다' });
    if (basis.refundableAmount <= 0) throw new ProblemError({ type: 'case-nothing-to-refund', status: 409, title: '환급할 남은 금액이 없습니다' });
    const approval = await this.approvalLifecycle.request({ kind: 'SYSTEM_FAULT_REFUND', targetRef: basis.orderId, amount: basis.refundableAmount, reasonCode: 'TICKET_NOT_ISSUED', reasonText: parsed.data.reason }, { ...actorOf(me), role: 'cs_agent', sessionId: 'case-action' });
    await this.cases.resolveAsSystem(caseId, `system-refund:${parsed.data.reason}`, Date.now(), me.accountId);
    return approval;
  }

}
