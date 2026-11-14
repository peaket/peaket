// 받는 층: 스캐너 기기 승인 로그인(openapi POST /v1/scanner/device-authorizations·/v1/scanner/token, GAT-220).
// 기기 키 DPoP 증명만 요구한다(사람 토큰 없음). Origin이 스캐너 PWA 출처가 아니면 거절한다(ADR-0065 결정 10).
import { Controller, Headers, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { CreateScannerDeviceAuthorizationBody, CreateScannerDeviceAuthorizationResponse, CreateScannerTokenBody } from '@peaket/contracts/openapi/scanner';
import { CLOCK, type Clock, ContractBody, ContractRouteSchema, DpopRejected, type DpopReplayStore, ProblemError, Roles, verifyDpopProof } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DeviceAuthorizationError, StartDeviceAuthorization } from '../application/start-device-authorization.js';
import { PollScannerToken, ScannerTokenError } from '../application/poll-scanner-token.js';
import { SCANNER_DPOP_REPLAY } from '../domain/ports.js';
import { requestUrlOf } from './request-url.js';

export const SCANNER_PWA_ORIGIN_ENV = 'PEAKET_SCANNER_PWA_ORIGIN';
const DEFAULT_PWA_ORIGIN = 'https://scanner.peaket.example';

function assertScannerOrigin(origin: unknown): void {
  const expected = process.env[SCANNER_PWA_ORIGIN_ENV] ?? DEFAULT_PWA_ORIGIN;
  if (typeof origin !== 'string' || origin !== expected) {
    throw new ProblemError({ type: 'scanner-origin-forbidden', status: 403, title: '스캐너 앱 출처가 아닙니다' });
  }
}

const ScannerTokenResponse = z.object({ access_token: z.string(), token_type: z.literal('DPoP'), expires_in: z.int().min(0) });

@Controller('v1/scanner')
export class ScannerAuthorizationController {
  constructor(
    private readonly start: StartDeviceAuthorization,
    private readonly poll: PollScannerToken,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SCANNER_DPOP_REPLAY) private readonly replay: DpopReplayStore,
  ) {}

  private async jktOf(proof: unknown, request: FastifyRequest): Promise<string> {
    try {
      const verified = await verifyDpopProof({
        proof: typeof proof === 'string' ? proof : '',
        method: request.method,
        url: requestUrlOf(request),
        requireAth: false,
        clock: this.clock,
        replay: this.replay,
      });
      return verified.jkt;
    } catch (e) {
      if (e instanceof DpopRejected) throw new ProblemError({ type: 'invalid-dpop-proof', status: 400, title: 'DPoP 증명이 올바르지 않습니다' });
      throw e;
    }
  }

  @Post('device-authorizations')
  @HttpCode(200)
  @ContractRouteSchema({ body: CreateScannerDeviceAuthorizationBody, responses: { 200: CreateScannerDeviceAuthorizationResponse } })
  @Roles(['public'])
  async authorize(
    @Headers('origin') origin: unknown,
    @Headers('dpop') proof: unknown,
    @ContractBody(CreateScannerDeviceAuthorizationBody) _body: z.output<typeof CreateScannerDeviceAuthorizationBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.output<typeof CreateScannerDeviceAuthorizationResponse>> {
    void reply.header('cache-control', 'no-store');
    assertScannerOrigin(origin);
    const jkt = await this.jktOf(proof, request);
    try {
      return await this.start.run({ jkt });
    } catch (e) {
      if (e instanceof DeviceAuthorizationError) {
        if (e.code === 'RATE_LIMITED') throw new ProblemError({ type: 'scanner-login-rate-limited', status: 429, title: '승인 요청이 너무 잦습니다' });
        if (e.code === 'DEVICE_REVOKED') throw new ProblemError({ type: 'device-revoked', status: 403, title: '폐기된 스캐너 기기입니다' });
        if (e.code === 'REGISTRY_UNAVAILABLE') throw new ProblemError({ type: 'scanner-auth-unavailable', status: 503, title: '스캐너 기기·세션을 확인하지 못했습니다', retryAfterSeconds: 1 });
        throw new ProblemError({ type: 'device-unregistered', status: 403, title: '등록되지 않은 스캐너 기기입니다' });
      }
      throw e;
    }
  }

  @Post('token')
  @HttpCode(200)
  @ContractRouteSchema({ body: CreateScannerTokenBody, responses: { 200: ScannerTokenResponse } })
  @Roles(['public'])
  async token(
    @Headers('origin') origin: unknown,
    @Headers('dpop') proof: unknown,
    @ContractBody(CreateScannerTokenBody) body: z.output<typeof CreateScannerTokenBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    void reply.header('cache-control', 'no-store');
    assertScannerOrigin(origin);
    const jkt = await this.jktOf(proof, request);
    try {
      return await this.poll.run({ deviceCode: body.deviceCode, jkt });
    } catch (e) {
      if (e instanceof ScannerTokenError) {
        if (e.code === 'device_revoked') throw new ProblemError({ type: 'device-revoked', status: 403, title: '폐기된 스캐너 기기입니다' });
        void reply.code(400);
        return {
          error: e.code,
          ...(e.retryAfterSec !== undefined ? { interval: e.retryAfterSec } : {}),
          ...(e.code === 'authorization_pending' ? { error_description: '사용자의 승인을 기다리는 중입니다' } : {}),
        };
      }
      throw e;
    }
  }
}
