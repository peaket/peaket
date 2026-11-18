// 받는 층: 입장 토큰 공개키 묶음 GET /internal/jwks/admission.json(docs/features/queue-admission.md §6 '입장 토큰 공개키 묶음과 게이트웨이 확인', ADR-0288 결정 2, Q-T69 ①).
// 앱 포트에서 클러스터 안에만 낸다(게이트웨이는 /internal/을 내지 않는다, docs/infra.md §4.1 '호스트와 내부 경로'). 부르는 쪽은 purchase-svc다(메시 허용 queue-svc rest).
// 공개 값이라 내부 토큰을 요구하지 않는다. 다른 파일 이름은 identity의 /internal/jwks와 같은 404 Problem이다.
// 응답 스키마가 원소의 칸을 공개 부분(kty·crv·x·y·kid·alg·use와 옛 키의 peaket_until)으로 묶는다: 스키마에 없는 칸(d 같은 개인 성분)은 직렬화하지 않는다.
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import { CLOCK, type Clock, ContractRouteSchema, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ADMISSION_TOKENS, type AdmissionJwk, type AdmissionTokens } from '../domain/ports.js';

/** 묶음 파일 이름 */
export const ADMISSION_JWKS_FILE = 'admission.json';

const JwksParams = z.object({ file: z.string() }).strict();
const AdmissionJwkView = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string(),
  y: z.string(),
  kid: z.string(),
  alg: z.literal('ES256'),
  use: z.literal('sig'),
  peaket_until: z.number().int().optional(),
});
const AdmissionJwksView = z.object({ keys: z.array(AdmissionJwkView) });

@Controller()
export class AdmissionJwksController {
  constructor(
    @Inject(ADMISSION_TOKENS) private readonly signer: AdmissionTokens,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('internal/jwks/:file')
  @Roles(['public'])
  @ContractRouteSchema({ params: JwksParams, responses: { 200: AdmissionJwksView } })
  jwks(@Param('file') file: string, @Res({ passthrough: true }) reply: FastifyReply): { keys: AdmissionJwk[] } {
    if (file !== ADMISSION_JWKS_FILE) throw new ProblemError({ type: 'jwks-not-found', status: 404, title: '없는 공개키 묶음입니다' });
    void reply.header('cache-control', 'max-age=300').header('content-type', 'application/json; charset=utf-8');
    return this.signer.jwks(this.clock.now());
  }
}
