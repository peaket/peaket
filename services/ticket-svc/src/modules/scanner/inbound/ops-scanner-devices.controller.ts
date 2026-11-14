// 받는 층: 관제 스캐너 기기 관리(openapi /v1/ops/scanner-devices, SCR-053 서버 계약, BUILD_ORDER GAT-170).
// 역할은 platform RolesGuard가 identity GetAdminAuthz로 판정한다(operator 이상 등록·폐기, viewer는 목록만).
// 기기 원장의 주인은 ticket-svc이고, 응답의 enrollmentCode는 이 응답에만 싣는다.
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
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ScannerDeviceInactive, ScannerDeviceNotFound, ScannerDevices } from '../application/scanner-devices.js';
import { ScannerDeviceInputError } from '../domain/scanner-device.js';

function reject(e: unknown): never {
  if (e instanceof ScannerDeviceInputError) throw new RequestValidationError(`스캐너 기기 입력이 올바르지 않습니다: ${e.code}`);
  if (e instanceof ScannerDeviceNotFound) throw new ProblemError({ type: 'scanner-device-not-found', status: 404, title: '스캐너 기기를 찾을 수 없습니다' });
  if (e instanceof ScannerDeviceInactive) throw new ProblemError({ type: 'scanner-device-inactive', status: 409, title: '폐기·퇴역한 스캐너 기기입니다' });
  throw e;
}

@Controller('v1/ops/scanner-devices')
export class OpsScannerDevicesController {
  constructor(private readonly devices: ScannerDevices) {}

  @Get()
  @ContractRouteSchema({ query: ListOpsScannerDevicesQueryParams, responses: { 200: ListOpsScannerDevicesResponse } })
  @Roles(['viewer', 'operator', 'commander'])
  async list(@ContractQuery(ListOpsScannerDevicesQueryParams) query: z.output<typeof ListOpsScannerDevicesQueryParams>, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ items: unknown[]; nextCursor?: string }> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.devices.list(query);
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
      const r = await this.devices.register({ name: body.name, promoterId: body.promoterId, enrolledBy: me.accountId });
      return { ...r.device, enrollmentCode: r.enrollmentCode, enrollmentCodeExpiresAt: r.enrollmentCodeExpiresAt };
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
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CreateOpsScannerDeviceEnrollmentCodeResponse>> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.devices.issueCode({ deviceId: params.deviceId });
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
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CreateOpsScannerDeviceRevocationResponse>> {
    void reply.header('cache-control', 'no-store');
    try {
      return await this.devices.revoke({ deviceId: params.deviceId, reason: body.reason });
    } catch (e) {
      reject(e);
    }
  }
}
