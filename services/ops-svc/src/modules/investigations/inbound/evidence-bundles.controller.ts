// F-04-14 증거 묶음 API(openapi 태그 investigations, FR-074).
// 지정 확인·접속기록은 F-04-12 조사 경로와 같고, 모든 응답은 Cache-Control: no-store다.
import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import {
  CreateOpsEvidenceBundleExportBody,
  CreateOpsEvidenceBundleExportParams,
  CreateOpsEvidenceBundleExportResponse,
  CreateOpsEvidenceBundleHoldChangeBody,
  CreateOpsEvidenceBundleHoldChangeParams,
  CreateOpsEvidenceBundleHoldChangeResponse,
  CreateOpsEvidenceBundleHoldEndConfirmationParams,
  CreateOpsEvidenceBundleHoldEndConfirmationResponse,
  CreateOpsEvidenceBundleHoldEndRequestBody,
  CreateOpsEvidenceBundleHoldEndRequestParams,
  CreateOpsEvidenceBundleHoldEndRequestResponse,
  CreateOpsFraudCaseEvidenceBundleBody,
  CreateOpsFraudCaseEvidenceBundleParams,
  CreateOpsFraudCaseEvidenceBundleResponse,
  GetOpsEvidenceBundleParams,
  GetOpsEvidenceBundleResponse,
  ListOpsEvidenceBundlesResponse,
} from '@peaket/contracts/openapi/investigations';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, Idempotent, ProblemError, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { OPS_ROLES, type AdminRole } from '../../admin-accounts/index.js';
import { EvidenceBundles } from '../application/fraud-evidence.js';
import { Investigations } from '../application/investigations.js';
import { bareProblem } from '../application/bare-problem.js';

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
/** 내보내기 응답은 200 CSV 문자열 또는 200/201 JSON이다. 둘 다 칸을 거르지 않도록 열어 둔다. */
const ExportResponse = z.union([z.string(), z.looseObject({})]);

@Controller('v1/ops')
export class EvidenceBundlesController {
  constructor(private readonly evidence: EvidenceBundles, private readonly investigations: Investigations) {}

  @Post('fraud-cases/:caseId/evidence-bundles')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @Idempotent({ operation: 'CREATE_EVIDENCE_BUNDLE' })
  @ContractRouteSchema({ params: CreateOpsFraudCaseEvidenceBundleParams, responses: { 201: CreateOpsFraudCaseEvidenceBundleResponse } })
  async create(
    @ContractParams(CreateOpsFraudCaseEvidenceBundleParams) params: { caseId: string },
    @ContractBody(CreateOpsFraudCaseEvidenceBundleBody) body: { reason: string },
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      await this.investigations.authorize(actorOf(me), 'EVIDENCE_CREATE', { caseId: params.caseId });
      const view = await this.evidence.create(actorOf(me), params.caseId, idem, body);
      void reply.header('location', `/v1/ops/evidence-bundles/${String(view.bundleId)}`);
      return view;
    } catch (e) {
      reject(e);
    }
  }

  @Get('evidence-bundles')
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @ContractRouteSchema({ responses: { 200: ListOpsEvidenceBundlesResponse } })
  async list(@Query() q: Record<string, string | string[] | undefined>, @CurrentPrincipal() me: Principal) {
    try {
      const eventId = one(q.eventId);
      if (!eventId) throw bareProblem('invalid-query', 400, 'eventId가 필요합니다');
      await this.investigations.authorize(actorOf(me), 'EVIDENCE_LIST', { eventId });
      return await this.evidence.list(actorOf(me), { eventId, ...(one(q.cursor) ? { cursor: one(q.cursor)! } : {}), limit: one(q.limit) ? Math.min(100, Math.max(1, Number(one(q.limit)))) : 50 });
    } catch (e) {
      reject(e);
    }
  }

  @Get('evidence-bundles/:bundleId')
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @ContractRouteSchema({ params: GetOpsEvidenceBundleParams, responses: { 200: z.looseObject({}) } })
  async get(@ContractParams(GetOpsEvidenceBundleParams) params: { bundleId: string }, @CurrentPrincipal() me: Principal) {
    try {
      await this.investigations.authorize(actorOf(me), 'EVIDENCE_VIEW', {});
      return await this.evidence.get(actorOf(me), params.bundleId);
    } catch (e) {
      reject(e);
    }
  }

  @Post('evidence-bundles/:bundleId/hold-changes')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @Idempotent({ operation: 'CHANGE_EVIDENCE_HOLD' })
  @ContractRouteSchema({ params: CreateOpsEvidenceBundleHoldChangeParams, responses: { 200: CreateOpsEvidenceBundleHoldChangeResponse } })
  async holdChange(
    @ContractParams(CreateOpsEvidenceBundleHoldChangeParams) params: { bundleId: string },
    @Body() body: { holdReason: 'DISPUTE' | 'INVESTIGATION'; basis: string },
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
  ) {
    try {
      await this.investigations.authorize(actorOf(me), 'EVIDENCE_HOLD_CHANGE', {});
      return await this.evidence.holdChange(actorOf(me), params.bundleId, idem, body);
    } catch (e) {
      reject(e);
    }
  }

  @Post('evidence-bundles/:bundleId/hold-end-requests')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @Idempotent({ operation: 'REQUEST_EVIDENCE_HOLD_END' })
  @ContractRouteSchema({ params: CreateOpsEvidenceBundleHoldEndRequestParams, responses: { 201: CreateOpsEvidenceBundleHoldEndRequestResponse } })
  async holdEndRequest(
    @ContractParams(CreateOpsEvidenceBundleHoldEndRequestParams) params: { bundleId: string },
    @ContractBody(CreateOpsEvidenceBundleHoldEndRequestBody) body: { basis: string },
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
  ) {
    try {
      await this.investigations.authorize(actorOf(me), 'EVIDENCE_HOLD_END_REQUEST', {});
      return await this.evidence.holdEndRequest(actorOf(me), params.bundleId, idem, body);
    } catch (e) {
      reject(e);
    }
  }

  @Post('evidence-bundles/:bundleId/hold-end-confirmations')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Roles(['commander'] as AdminRole[])
  @Idempotent({ operation: 'CONFIRM_EVIDENCE_HOLD_END' })
  @ContractRouteSchema({ params: CreateOpsEvidenceBundleHoldEndConfirmationParams, responses: { 200: CreateOpsEvidenceBundleHoldEndConfirmationResponse } })
  async holdEndConfirm(
    @ContractParams(CreateOpsEvidenceBundleHoldEndConfirmationParams) params: { bundleId: string },
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    try {
      return await this.evidence.holdEndConfirm({ accountId: me.accountId, role: me.role ?? 'viewer', sessionId: me.sessionId }, params.bundleId, idem, one(headers['x-reauth-token']));
    } catch (e) {
      reject(e);
    }
  }

  @Post('evidence-bundles/:bundleId/exports')
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @Idempotent({ operation: 'CREATE_EVIDENCE_EXPORT' })
  @ContractRouteSchema({ params: CreateOpsEvidenceBundleExportParams, responses: { 200: ExportResponse, 201: ExportResponse } })
  async export(
    @ContractParams(CreateOpsEvidenceBundleExportParams) params: { bundleId: string },
    @Body() body: { kind: 'AUTHORITY' | 'PROMOTER' | 'COMPLAINT'; dataRequestId?: string; reason: string },
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      await this.investigations.authorize(actorOf(me), 'EVIDENCE_EXPORT', {});
      const out = await this.evidence.export(actorOf(me), params.bundleId, idem, body);
      if (body.kind === 'PROMOTER') {
        void reply.type('text/csv; charset=utf-8').code(200);
        return String((out as { csv?: unknown }).csv ?? '');
      }
      void reply.code(body.kind === 'AUTHORITY' ? 201 : 200);
      return out;
    } catch (e) {
      reject(e);
    }
  }
}
