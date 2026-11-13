// 받는 층: 스캐너 기기 등록(openapi POST /v1/scanner/device-enrollments, BUILD_ORDER GAT-170).
// 인증 전 공개 경로이고, 등록 코드와 DPoP 증명(토큰 없음, ath 없음)으로 기기 키 지문(jkt)을 묶는다.
// 코드 원문은 로그·응답 밖에 남기지 않고, 코드는 1회용·10분 [가정]이다(offline-gate §6.1).
import { Body, Controller, Headers, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { CreateScannerDeviceEnrollmentBody, CreateScannerDeviceEnrollmentResponse } from '@peaket/contracts/openapi/scanner';
import { CLOCK, type Clock, ContractBody, ContractRouteSchema, DpopRejected, ProblemError, RequestValidationError, Roles, verifyDpopProof } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EnrollmentCodeRejected, ScannerDevices } from '../application/scanner-devices.js';
import { ScannerDeviceInputError } from '../domain/scanner-device.js';
import { DPOP_REPLAY_STORE, type DpopReplayStore } from '../domain/ports.js';
import { requestUrlOf } from './http-url.js';

@Controller('v1/scanner')
export class ScannerEnrollmentController {
  constructor(
    private readonly devices: ScannerDevices,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DPOP_REPLAY_STORE) private readonly replay: DpopReplayStore,
  ) {}

  @Post('device-enrollments')
  @HttpCode(201)
  @ContractRouteSchema({ body: CreateScannerDeviceEnrollmentBody, responses: { 201: CreateScannerDeviceEnrollmentResponse } })
  @Roles(['public'])
  async enroll(
    @Headers('dpop') proof: unknown,
    @ContractBody(CreateScannerDeviceEnrollmentBody) body: z.output<typeof CreateScannerDeviceEnrollmentBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CreateScannerDeviceEnrollmentResponse>> {
    void reply.header('cache-control', 'no-store');
    let verified: { jkt: string };
    try {
      verified = await verifyDpopProof({
        proof: typeof proof === 'string' ? proof : '',
        method: request.method,
        url: requestUrlOf(request),
        requireAth: false,
        clock: this.clock,
        replay: this.replay,
      });
    } catch (e) {
      if (e instanceof DpopRejected) throw new ProblemError({ type: 'invalid-dpop-proof', status: 400, title: 'DPoP 증명이 올바르지 않습니다' });
      throw e;
    }
    try {
      return await this.devices.enroll({ code: body.code, jkt: verified.jkt });
    } catch (e) {
      if (e instanceof EnrollmentCodeRejected) {
        if (e.reason === 'INVALID') throw new ProblemError({ type: 'invalid-enrollment-code', status: 400, title: '등록 코드 형식이 올바르지 않습니다' });
        if (e.reason === 'KEY_IN_USE') throw new ProblemError({ type: 'scanner-device-key-in-use', status: 409, title: '이미 다른 기기에 묶인 기기 키입니다' });
        throw new ProblemError({ type: 'enrollment-code-expired', status: 410, title: '등록 코드가 만료되었거나 이미 사용되었습니다' });
      }
      if (e instanceof ScannerDeviceInputError) throw new RequestValidationError(`등록 코드가 올바르지 않습니다: ${e.code}`);
      throw e;
    }
  }
}
