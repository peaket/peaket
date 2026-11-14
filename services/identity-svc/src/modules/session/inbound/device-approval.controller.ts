// 받는 층: 스캐너 승인 화면 조회·승인·거부(openapi POST /v1/device-approval-lookups·/v1/device-approvals, SCR-051, GAT-220).
// 확인 코드는 URL 조각에서 꺼내 본문으로만 받고, 응답에 배정 파트너 이름은 싣지 않는다.
import { Controller, HttpCode, Post, Res } from '@nestjs/common';
import { CreateDeviceApprovalBody, CreateDeviceApprovalLookupBody, CreateDeviceApprovalLookupResponse } from '@peaket/contracts/openapi/identity';
import { ContractBody, ContractRouteSchema, CurrentPrincipal, ProblemError, Roles, type Principal } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { DeviceApprovalError, DeviceApprovals } from '../application/device-approvals.js';

function reject(e: unknown): never {
  if (e instanceof DeviceApprovalError) {
    if (e.code === 'NOT_FOUND') throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
    if (e.code === 'STAFF_ASSIGNMENT_MISSING') throw new ProblemError({ type: 'staff-assignment-missing', status: 403, title: '이 회차의 스태프 배정이 없습니다' });
    if (e.code === 'OTHER_PARTNER_DEVICE') throw new ProblemError({ type: 'other-partner-device', status: 403, title: '다른 파트너사의 기기입니다' });
    if (e.code === 'OUTSIDE_STAFF_HOURS') throw new ProblemError({ type: 'outside-staff-hours', status: 403, title: '근무 시간이 아닙니다' });
    if (e.code === 'ASSIGNMENT_REQUIRED') throw new ProblemError({ type: 'assignment-required', status: 422, title: '승인할 배정을 하나 골라 주세요' });
    if (e.code === 'ASSIGNMENT_NOT_ALLOWED') throw new ProblemError({ type: 'staff-assignment-missing', status: 403, title: '이 회차의 스태프 배정이 없습니다' });
    if (e.code === 'PROXY_NOT_ALLOWED') throw new ProblemError({ type: 'proxy-approval-forbidden', status: 403, title: '대리 승인은 현장 책임자만 할 수 있습니다' });
    if (e.code === 'RATE_LIMITED') throw new ProblemError({ type: 'scanner-login-rate-limited', status: 429, title: '승인 요청이 너무 잦습니다', retryAfterSeconds: Math.max(1, Math.ceil((e.retryAfterMs ?? 0) / 1000)) });
    if (e.code === 'ALREADY_HANDLED') throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
  }
  throw e;
}

@Controller()
export class DeviceApprovalController {
  constructor(private readonly approvals: DeviceApprovals) {}

  @Post('v1/device-approval-lookups')
  @HttpCode(200)
  @ContractRouteSchema({ body: CreateDeviceApprovalLookupBody, responses: { 200: CreateDeviceApprovalLookupResponse } })
  @Roles(['fan'])
  async lookup(
    @ContractBody(CreateDeviceApprovalLookupBody) body: z.output<typeof CreateDeviceApprovalLookupBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CreateDeviceApprovalLookupResponse>> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.approvals.lookup({ userCode: body.userCode, accountId: me.accountId });
    } catch (e) {
      reject(e);
    }
  }

  @Post('v1/device-approvals')
  @HttpCode(204)
  @ContractRouteSchema({ body: CreateDeviceApprovalBody, responses: { 204: z.object({}).strict() } })
  @Roles(['fan'])
  async decide(
    @ContractBody(CreateDeviceApprovalBody) body: z.output<typeof CreateDeviceApprovalBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    try {
      await this.approvals.decide({
        userCode: body.userCode,
        accountId: me.accountId,
        sessionId: me.sessionId,
        decision: body.decision,
        ...(body.assignmentId !== undefined ? { assignmentId: body.assignmentId } : {}),
        ...(body.proxy !== undefined ? { proxy: body.proxy } : {}),
      });
    } catch (e) {
      reject(e);
    }
  }
}
