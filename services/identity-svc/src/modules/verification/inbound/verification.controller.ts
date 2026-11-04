// 받는 층: 휴대폰 본인확인 시작·결과 확정·결과 조회(openapi /v1/identity/verifications*, docs/features/identity.md §5, FR-002).
// 팬 경로라 게이트웨이가 넘긴 신원으로 계정을 정하고, 남의 건은 404다. 결과 응답은 캐시하지 않는다.
import { Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ContractBody, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { ConfirmVerification } from '../application/confirm-verification.js';
import { GetVerificationResult } from '../application/get-verification-result.js';
import { StartVerification } from '../application/start-verification.js';
import { VerificationError } from '../application/verification-error.js';
import { PURPOSES } from '../domain/verification.js';

// openapi 요청 본문 모양(계약 생성물의 작업별 스키마가 operationId 정리(wbs 0.2.3) 뒤 이름이 바뀌어 여기 같은 모양으로 둔다)
const StartBody = z.object({ purpose: z.enum(PURPOSES).default('FIRST'), next: z.string().max(512) }).strict();
const ResultBody = z.object({ providerResult: z.record(z.string(), z.string()) }).strict();

const PROBLEM: Record<VerificationError['code'], { status: number; type: string; title: string; retryAfterSeconds?: number }> = {
  NEXT_INVALID: { status: 400, type: 'next-invalid', title: '돌아갈 주소가 같은 출처 경로가 아닙니다' },
  ALREADY_VERIFIED: { status: 409, type: 'already-verified', title: '이미 본인확인을 마친 계정입니다' },
  NOT_FOUND: { status: 404, type: 'not-found', title: '본인확인 건을 찾을 수 없습니다' },
  DUPLICATE_ACCOUNT: { status: 409, type: 'duplicate-account', title: '이미 다른 계정에서 본인확인한 분입니다. 그 계정으로 로그인해 주세요' },
  PROVIDER_DOWN: { status: 503, type: 'provider-down', title: '지금은 본인확인을 할 수 없습니다', retryAfterSeconds: 30 },
  PURPOSE_UNSUPPORTED: { status: 400, type: 'purpose-not-supported', title: '아직 받지 않는 본인확인 목적입니다' },
  UNDER_14: { status: 403, type: 'under-14', title: '만 14세 미만은 피켓을 이용할 수 없습니다' },
};

async function problem<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof VerificationError) throw new ProblemError(PROBLEM[e.code]);
    throw e;
  }
}

@Controller('v1/identity/verifications')
export class VerificationController {
  constructor(
    private readonly startVerification: StartVerification,
    private readonly confirmVerification: ConfirmVerification,
    private readonly getResult: GetVerificationResult,
  ) {}

  @Post()
  @Roles(['fan'])
  @HttpCode(201)
  async start(@ContractBody(StartBody) body: z.output<typeof StartBody>, @CurrentPrincipal() me: Principal) {
    const r = await problem(this.startVerification.run({ accountId: me.accountId, sessionId: me.sessionId, purpose: body.purpose, next: body.next }));
    return { verificationId: r.verificationId, window: r.window, expiresAt: new Date(r.expiresAt).toISOString() };
  }

  @Post(':verificationId/result')
  @Roles(['fan'])
  @HttpCode(200)
  async confirm(@Param('verificationId') id: string, @ContractBody(ResultBody) body: z.output<typeof ResultBody>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return problem(this.confirmVerification.run({ accountId: me.accountId, verificationId: id, providerResult: body.providerResult }));
  }

  @Get(':verificationId/result')
  @Roles(['fan'])
  async result(@Param('verificationId') id: string, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return problem(this.getResult.run({ accountId: me.accountId, verificationId: id }));
  }
}
