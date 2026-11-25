// F-04-12 조사 API(openapi 태그 investigations). 모든 경로는 요청마다 FRAUD_INVESTIGATOR 지정을 확인하고,
// 성공·거절을 접속기록에 남긴다. 응답은 Cache-Control: no-store다.
import { Body, Controller, Get, Header, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import {
  CreateOpsEventFraudClusterRunParams,
  CreateOpsEventFraudClusterRunResponse,
  CreateOpsFraudCaseAppealRequestBody,
  CreateOpsFraudCaseAppealRequestParams,
  CreateOpsFraudCaseAppealRequestResponse,
  CreateOpsFraudCaseBody,
  GetOpsEventFraudOverviewParams,
  GetOpsEventFraudOverviewResponse,
  GetOpsFraudCaseParams,
  GetOpsFraudCaseResponse,
  GetOpsFraudClusterParams,
  GetOpsFraudClusterResponse,
  ListOpsFraudCasesResponse,
  ListOpsFraudClustersResponse,
  UpdateOpsFraudCaseBody,
  UpdateOpsFraudCaseParams,
  UpdateOpsFraudCaseResponse,
} from '@peaket/contracts/openapi/investigations';
import { ContractBody, ContractParams, ContractRouteSchema, CurrentPrincipal, IdempotencyRequest, Idempotent, ProblemError, RequestValidationError, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { OPS_ROLES, type AdminRole } from '../../admin-accounts/index.js';
import { etag, Investigations, type FraudActor } from '../application/investigations.js';

const actorOf = (me: Principal): FraudActor => ({ accountId: me.accountId, role: me.role ?? 'viewer' });

const reject = (e: unknown): never => {
  if (e && typeof e === 'object' && 'type' in e && 'status' in e) {
    const p = e as { type: string; status: number; message?: string };
    throw new ProblemError({ type: p.type, status: p.status, title: p.message ?? p.type, cause: e });
  }
  throw e;
};

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined);
const listOf = (v: string | string[] | undefined): string[] | undefined => {
  if (v === undefined) return undefined;
  return (Array.isArray(v) ? v : String(v).split(',')).map((s) => s.trim()).filter(Boolean);
};

@Controller('v1/ops')
export class InvestigationsController {
  constructor(private readonly investigations: Investigations) {}

  @Get('events/:eventId/fraud-overview')
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @ContractRouteSchema({ params: GetOpsEventFraudOverviewParams, responses: { 200: GetOpsEventFraudOverviewResponse } })
  async overview(@ContractParams(GetOpsEventFraudOverviewParams) params: { eventId: string }, @CurrentPrincipal() me: Principal) {
    try {
      return await this.investigations.overview(actorOf(me), params.eventId);
    } catch (e) {
      reject(e);
    }
  }

  @Post('events/:eventId/fraud-cluster-runs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @Idempotent({ operation: 'CREATE_FRAUD_CLUSTER_RUN' })
  @ContractRouteSchema({ params: CreateOpsEventFraudClusterRunParams, responses: { 202: CreateOpsEventFraudClusterRunResponse } })
  async rerun(
    @ContractParams(CreateOpsEventFraudClusterRunParams) params: { eventId: string },
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() _idem: IdempotencyRequest,
  ) {
    try {
      return await this.investigations.rerun(actorOf(me), params.eventId);
    } catch (e) {
      reject(e);
    }
  }

  @Get('fraud-clusters')
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @ContractRouteSchema({ responses: { 200: ListOpsFraudClustersResponse } })
  async listClusters(@Query() q: Record<string, string | string[] | undefined>, @CurrentPrincipal() me: Principal) {
    try {
      const eventId = one(q.eventId);
      if (!eventId) throw new RequestValidationError('eventId가 필요합니다');
      const sort = one(q.sort);
      return await this.investigations.listClusters(actorOf(me), {
        eventId,
        sort: sort === 'PURCHASE_RATIO_DESC' || sort === 'LATEST' ? sort : 'SCORE_DESC',
        ...(one(q.cursor) ? { cursor: one(q.cursor)! } : {}),
        limit: one(q.limit) ? Math.min(100, Math.max(1, Number(one(q.limit)))) : 50,
      });
    } catch (e) {
      reject(e);
    }
  }

  @Get('fraud-clusters/:clusterId')
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @ContractRouteSchema({ params: GetOpsFraudClusterParams, responses: { 200: GetOpsFraudClusterResponse } })
  async getCluster(@ContractParams(GetOpsFraudClusterParams) params: { clusterId: string }, @CurrentPrincipal() me: Principal) {
    try {
      return await this.investigations.getCluster(actorOf(me), params.clusterId);
    } catch (e) {
      reject(e);
    }
  }

  @Post('fraud-cases')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @Idempotent({ operation: 'CREATE_FRAUD_CASE' })
  @ContractRouteSchema({ responses: { 201: GetOpsFraudCaseResponse } })
  async createCase(
    @ContractBody(CreateOpsFraudCaseBody) body: { clusterId: string; reasonCategory?: string },
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      const out = await this.investigations.createCase(actorOf(me), body, idem.key);
      void reply.header('location', out.location);
      return out.view;
    } catch (e) {
      reject(e);
    }
  }

  @Get('fraud-cases')
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @ContractRouteSchema({ responses: { 200: ListOpsFraudCasesResponse } })
  async listCases(@Query() q: Record<string, string | string[] | undefined>, @CurrentPrincipal() me: Principal) {
    try {
      const status = listOf(q.status);
      return await this.investigations.listCases(actorOf(me), {
        ...(one(q.eventId) ? { eventId: one(q.eventId)! } : {}),
        ...(status ? { status: status as never } : {}),
        ...(one(q.cursor) ? { cursor: one(q.cursor)! } : {}),
        limit: one(q.limit) ? Math.min(100, Math.max(1, Number(one(q.limit)))) : 50,
      });
    } catch (e) {
      reject(e);
    }
  }

  @Get('fraud-cases/:caseId')
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @ContractRouteSchema({ params: GetOpsFraudCaseParams, responses: { 200: GetOpsFraudCaseResponse } })
  async getCase(
    @ContractParams(GetOpsFraudCaseParams) params: { caseId: string },
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      const out = await this.investigations.getCase(actorOf(me), params.caseId);
      void reply.header('etag', etag(out.version));
      return out.view;
    } catch (e) {
      reject(e);
    }
  }

  @Patch('fraud-cases/:caseId')
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @ContractRouteSchema({ params: UpdateOpsFraudCaseParams, responses: { 200: UpdateOpsFraudCaseResponse } })
  async patchCase(
    @ContractParams(UpdateOpsFraudCaseParams) params: { caseId: string },
    @ContractBody(UpdateOpsFraudCaseBody) body: Parameters<Investigations['patchCase']>[3],
    @CurrentPrincipal() me: Principal,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      const out = await this.investigations.patchCase(actorOf(me), params.caseId, one(headers['if-match']), body);
      void reply.header('etag', etag(out.version));
      return out.view;
    } catch (e) {
      reject(e);
    }
  }

  @Post('fraud-cases/:caseId/appeal-requests')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Roles([...OPS_ROLES] as AdminRole[])
  @Idempotent({ operation: 'CREATE_FRAUD_APPEAL_REQUEST' })
  @ContractRouteSchema({
    params: CreateOpsFraudCaseAppealRequestParams,
    responses: { 201: CreateOpsFraudCaseAppealRequestResponse },
  })
  async appeal(
    @ContractParams(CreateOpsFraudCaseAppealRequestParams) params: { caseId: string },
    @ContractBody(CreateOpsFraudCaseAppealRequestBody) body: Parameters<Investigations['appeal']>[3],
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
  ) {
    try {
      return await this.investigations.appeal(actorOf(me), params.caseId, idem.key, body);
    } catch (e) {
      reject(e);
    }
  }
}
