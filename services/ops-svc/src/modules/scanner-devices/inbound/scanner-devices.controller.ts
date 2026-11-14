// 받는 층: 관제 스캐너 기기 관리(openapi /v1/ops/scanner-devices*, SCR-053, ADR-0148, BAT-450).
// 권한은 platform RolesGuard가 identity GetAdminAuthz로 판정한다(operator 이상 등록·폐기, viewer는 목록만).
// 기기 원장은 ticket-svc gRPC가 쓰고, ops-svc는 감사 기록과 문제 응답을 맡는다.
import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import {
  CreateOpsScannerDeviceBody,
  CreateOpsScannerDeviceEnrollmentCodeParams,
  CreateOpsScannerDeviceEnrollmentCodeResponse,
  CreateOpsScannerDeviceResponse,
  CreateOpsScannerDeviceRevocationBody,
  CreateOpsScannerDeviceRevocationParams,
  CreateOpsScannerDeviceRevocationResponse,
  ListOpsScannerDevicesQueryParams,
  ListOpsScannerDevicesResponse,
} from '@peaket/contracts/openapi/ops';
import { ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, ProblemError, RequestValidationError, Roles, type Principal } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { OpsScannerDevices } from '../application/scanner-devices.js';
import {
  ScannerDeviceDependencyUnavailable,
  ScannerDeviceInactive,
  ScannerDeviceInputRejected,
  ScannerDeviceKeyInUse,
  ScannerDeviceNotFound,
} from '../domain/scanner-devices.js';

function reject(e: unknown): never {
  if (e instanceof ScannerDeviceInputRejected) throw new RequestValidationError(`스캐너 기기 입력이 올바르지 않습니다: ${e.detail}`);
  if (e instanceof ScannerDeviceNotFound) throw new ProblemError({ type: 'scanner-device-not-found', status: 404, title: '스캐너 기기를 찾을 수 없습니다' });
  if (e instanceof ScannerDeviceInactive) throw new ProblemError({ type: 'scanner-device-inactive', status: 409, title: '폐기·퇴역한 스캐너 기기입니다' });
  if (e instanceof ScannerDeviceKeyInUse) throw new ProblemError({ type: 'scanner-device-key-in-use', status: 409, title: '이미 다른 기기에 묶인 기기 키입니다' });
  if (e instanceof ScannerDeviceDependencyUnavailable) throw new ProblemError({ type: 'scanner-auth-unavailable', status: 503, title: '스캐너 기기·세션을 확인하지 못했습니다', retryAfterSeconds: 1 });
  throw e;
}

@Controller('v1/ops/scanner-devices')
export class OpsScannerDevicesController {
  constructor(private readonly devices: OpsScannerDevices) {}

  @Get()
  @ContractRouteSchema({ query: ListOpsScannerDevicesQueryParams, responses: { 200: ListOpsScannerDevicesResponse } })
  @Roles(['viewer', 'operator', 'commander'])
  async list(@ContractQuery(ListOpsScannerDevicesQueryParams) query: z.output<typeof ListOpsScannerDevicesQueryParams>, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ items: unknown[]; nextCursor?: string }> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.devices.list({ ...(query.cursor !== undefined ? { cursor: query.cursor } : {}), limit: query.limit ?? 50 });
    } catch (e) {
      reject(e);
    }
  }

  @Post()
  @HttpCode(201)
  @ContractRouteSchema({ body: CreateOpsScannerDeviceBody, responses: { 201: CreateOpsScannerDeviceResponse } })
  @Roles(['operator', 'commander'])
  async create(
    @ContractBody(CreateOpsScannerDeviceBody) body: z.output<typeof CreateOpsScannerDeviceBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CreateOpsScannerDeviceResponse>> {
    void reply.header('cache-control', 'no-store');
    try {
      const r = await this.devices.register({ requestId: randomUUID(), name: body.name, promoterId: body.promoterId, actedBy: me.accountId });
      return { ...r.device, enrollmentCode: r.enrollmentCode!, enrollmentCodeExpiresAt: r.enrollmentCodeExpiresAt! };
    } catch (e) {
      reject(e);
    }
  }

  @Post(':deviceId/enrollment-code')
  @HttpCode(201)
  @ContractRouteSchema({ params: CreateOpsScannerDeviceEnrollmentCodeParams, responses: { 201: CreateOpsScannerDeviceEnrollmentCodeResponse } })
  @Roles(['operator', 'commander'])
  async issueCode(
    @ContractParams(CreateOpsScannerDeviceEnrollmentCodeParams) params: z.output<typeof CreateOpsScannerDeviceEnrollmentCodeParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CreateOpsScannerDeviceEnrollmentCodeResponse>> {
    void reply.header('cache-control', 'no-store');
    try {
      const r = await this.devices.reissue({ requestId: randomUUID(), deviceId: params.deviceId, actedBy: me.accountId });
      return { enrollmentCode: r.enrollmentCode!, enrollmentCodeExpiresAt: r.enrollmentCodeExpiresAt! };
    } catch (e) {
      reject(e);
    }
  }

  @Post(':deviceId/revocation')
  @HttpCode(200)
  @ContractRouteSchema({ params: CreateOpsScannerDeviceRevocationParams, body: CreateOpsScannerDeviceRevocationBody, responses: { 200: CreateOpsScannerDeviceRevocationResponse } })
  @Roles(['operator', 'commander'])
  async revoke(
    @ContractParams(CreateOpsScannerDeviceRevocationParams) params: z.output<typeof CreateOpsScannerDeviceRevocationParams>,
    @ContractBody(CreateOpsScannerDeviceRevocationBody) body: z.output<typeof CreateOpsScannerDeviceRevocationBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CreateOpsScannerDeviceRevocationResponse>> {
    void reply.header('cache-control', 'no-store');
    try {
      return (await this.devices.revoke({ requestId: randomUUID(), deviceId: params.deviceId, reason: body.reason, actedBy: me.accountId })).device;
    } catch (e) {
      reject(e);
    }
  }
}
