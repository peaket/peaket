// 받는 층: 스캐너 기기 등록(openapi POST /v1/scanner/device-enrollments, BUILD_ORDER GAT-170).
// 인증 전 공개 경로이고, 등록 코드와 DPoP 증명(토큰 없음, ath 없음)으로 기기 키 지문(jkt)을 묶는다.
// 코드 원문은 로그·응답 밖에 남기지 않고, 코드는 1회용·10분 [가정]이다(offline-gate §6.1).
import { Body, Controller, Headers, HttpCode, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { CreateScannerDeviceEnrollmentBody, CreateScannerDeviceEnrollmentResponse } from '@peaket/contracts/openapi/scanner';
import { assertScannerOrigin, CLOCK, type Clock, ContractBody, ContractRouteSchema, DpopRejected, ProblemError, RequestValidationError, Roles, SCANNER_MTLS_AUTH_HEADER, SCANNER_MTLS_CERT_HEADER, verifyDpopProof } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EnrollmentCodeRejected, EnrollmentRateLimited, ScannerDevices, ScannerEnrollmentUnavailable } from '../application/scanner-devices.js';
import { ScannerDeviceInputError } from '../domain/scanner-device.js';
import { DPOP_REPLAY_STORE, type DpopReplayStore, SCANNER_MTLS_SECRET, SCANNER_PWA_ORIGIN } from '../domain/ports.js';
import { requestUrlOf } from './http-url.js';

/** 게이트웨이가 넘긴 출발지 IP(x-forwarded-for 첫 값)나 직접 연결 IP. 등록 실패 제한의 키다 */
function clientIpOf(request: FastifyRequest): string {
  const raw = request.headers['x-forwarded-for'];
  const first = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined)?.split(',')[0]?.trim();
  return first && first.length > 0 && first.length <= 128 ? first : request.ip;
}

@Controller('v1/scanner')
export class ScannerEnrollmentController {
  constructor(
    private readonly devices: ScannerDevices,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DPOP_REPLAY_STORE) private readonly replay: DpopReplayStore,
    @Inject(SCANNER_PWA_ORIGIN) private readonly pwaOrigin: string,
    @Optional() @Inject(SCANNER_MTLS_SECRET) private readonly mtlsSecret?: string,
  ) {}

  @Post('device-enrollments')
  @HttpCode(201)
  @ContractRouteSchema({ body: CreateScannerDeviceEnrollmentBody, responses: { 201: CreateScannerDeviceEnrollmentResponse } })
  @Roles(['public'])
  async enroll(
    @Headers('origin') origin: unknown,
    @Headers('dpop') proof: unknown,
    @ContractBody(CreateScannerDeviceEnrollmentBody) body: z.output<typeof CreateScannerDeviceEnrollmentBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CreateScannerDeviceEnrollmentResponse>> {
    // 출처 확인이 먼저다: 틀린 출처는 증명·IP 한도·코드를 건드리지 않고 등록 실패로도 세지 않는다(offline-gate §6.1 'GAT-170 마감 규칙', O-T35)
    assertScannerOrigin(origin, this.pwaOrigin);
    void reply.header('cache-control', 'no-store');
    // 게이트웨이가 클라이언트 인증서를 검증하고 넣은 머리가 있으면 그 지문(x5t#S256)을 MTLS_CERT로 묶는다.
    // 비밀 값이 없거나 다르면 mTLS를 믿지 않고 DPoP 경로로 내려간다(가짜 머리로 통과하지 않는다).
    const mtlsHeader = request.headers[SCANNER_MTLS_AUTH_HEADER];
    const cert = request.headers[SCANNER_MTLS_CERT_HEADER];
    let mtlsThumbprint: string | undefined;
    if (this.mtlsSecret && mtlsHeader !== undefined) {
      if (mtlsHeader !== this.mtlsSecret || typeof cert !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(cert)) {
        throw new ProblemError({ type: 'invalid-dpop-proof', status: 400, title: 'DPoP 증명이 올바르지 않습니다' });
      }
      mtlsThumbprint = cert;
    }
    let verified: { jkt: string };
    if (mtlsThumbprint !== undefined) {
      verified = { jkt: mtlsThumbprint };
    } else {
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
    }
    try {
      return await this.devices.enroll({
        code: body.code,
        jkt: verified.jkt,
        ip: clientIpOf(request),
        ...(mtlsThumbprint !== undefined ? { credentialType: 'MTLS_CERT' as const, thumbprint: mtlsThumbprint } : {}),
      });
    } catch (e) {
      if (e instanceof ScannerEnrollmentUnavailable) {
        throw new ProblemError({ type: 'scanner-auth-unavailable', status: 503, title: '스캐너 기기·세션을 확인하지 못했습니다', retryAfterSeconds: 1, cause: e });
      }
      if (e instanceof EnrollmentRateLimited) throw new ProblemError({ type: 'enrollment-rate-limited', status: 429, title: '등록 시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요', retryAfterSeconds: 600 });
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
