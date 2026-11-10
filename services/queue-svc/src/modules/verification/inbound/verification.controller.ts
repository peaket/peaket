// 받는 층: 추가 검증 제출·이의 제기·상태 읽기(openapi POST·GET /v1/queues/{eventId}/verification, docs/features/bot-defense.md §5.2·§12, ADR-0259 결정 1~5).
// 팬 경로라 게이트웨이가 넘긴 신원(계정·pid)을 쓴다. 대기 참여는 본문이 아니라 이 계정의 q:dup이 가리키는 대기표로 찾는다(남의 대기 참여를 고르지 못한다).
// 본문은 계약처럼 닫고(정하지 않은 칸 400), challengeToken과 appeal 가운데 정확히 하나만 받는다. application/json만 받는다(다른 형식 415, ASVS 3.5.2).
// 응답은 JSON뿐이고 캐시하지 않는다(ASVS 3.2.1·14.3.2). 응답 스키마 표시(@ContractRouteSchema responses)는 스키마에 없는 칸을 내보내지 않는다(ASVS 15.3.1).
import { Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { QueueVerificationAppealReceipt, QueueVerificationResult, QueueVerificationState, QueueVerificationSubmitRequest } from '@peaket/contracts/openapi/model';
import { ContractBody, ContractRouteSchema, CurrentPrincipal, type Principal, ProblemError, RequestValidationError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { QueueStoreUnavailable } from '../../entry/index.js';
import { ReadVerification } from '../application/read-verification.js';
import { SubmitAppeal } from '../application/submit-appeal.js';
import { SubmitVerification } from '../application/submit-verification.js';
import { VerificationError, type VerificationErrorCode } from '../application/verification-error.js';
import type { VerificationClient } from '../domain/ports.js';
import { appealFits } from '../domain/verification.js';

/** 기기 식별값: CSPRNG 128비트, base64url 22자(docs/frontend.md §3.12, 로비 입장·사전 검증과 같은 모양) */
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;
/** 사람 확인 토큰 상한(로비 입장·사전 검증과 같다, [가정]) */
const TOKEN_MAX = 2048;

// 계약 본문(닫힘, appeal 4,000 단위)에 계약 설명의 규칙을 더한다: 둘 가운데 정확히 하나, 기기 식별값 모양, 이의 글은 NFC 뒤 grapheme 1,000자
const SubmitBody = QueueVerificationSubmitRequest.superRefine((b, ctx) => {
  if ((b.challengeToken === undefined) === (b.appeal === undefined)) ctx.addIssue({ code: 'custom', message: 'challengeToken과 appeal 가운데 정확히 하나만 보낸다' });
  if (b.challengeToken !== undefined && (b.challengeToken.length === 0 || b.challengeToken.length > TOKEN_MAX)) ctx.addIssue({ code: 'custom', message: '사람 확인 토큰 길이가 틀렸다' });
  if (b.deviceId !== undefined && !DEVICE_ID.test(b.deviceId)) ctx.addIssue({ code: 'custom', message: '기기 식별값 모양이 틀렸다' });
  if (b.appeal !== undefined && !appealFits(b.appeal)) ctx.addIssue({ code: 'custom', message: '이의 글은 1,000자까지이고 NUL·양방향 제어·0폭 글자를 받지 않는다' });
});

/** Redis 키의 해시 태그 안에 들어가는 값(회차 ID·pid)의 모양 */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;

const PROBLEM: Record<Exclude<VerificationErrorCode, 'INVALID' | 'APPEAL_NOT_FOUND' | 'CASE_CONFLICT'>, { status: number; type: string; title: string; extensions?: Record<string, unknown> }> = {
  NOT_FOUND: { status: 404, type: 'queue-not-found', title: '이 회차의 대기열이 열리지 않았습니다' },
  ENTRY_NOT_FOUND: { status: 404, type: 'queue-entry-not-found', title: '이 회차에 대기 참여가 없습니다' },
  NOT_VERIFYING: { status: 409, type: 'not-verifying', title: '추가 검증 중인 대기표가 아닙니다' },
  SALE_ENDED: { status: 410, type: 'sale-ended', title: '판매 시간이 끝났습니다' },
  // 이의 기각으로 끝난 대기 참여: 새 type 없이 확장 칸으로 '기각' 문구를 고르게 한다(ADR-0259 결정 4)
  BLOCKED: { status: 410, type: 'queue-ticket-removed', title: '이 대기표는 더 쓸 수 없습니다', extensions: { removeReason: 'BLOCKED' } },
  SUBMIT_LIMITED: { status: 429, type: 'verification-submit-limited', title: '확인을 너무 많이 시도했습니다. 잠시 뒤 다시 시도해 주세요' },
  UNAVAILABLE: { status: 503, type: 'dependency-unavailable', title: '의존 서비스를 잠시 쓸 수 없습니다' },
  PUBLISH_FAILED: { status: 503, type: 'dependency-unavailable', title: '의존 서비스를 잠시 쓸 수 없습니다' },
  IDENTITY_VERIFICATION_REQUIRED: { status: 403, type: 'identity-verification-required', title: '휴대폰 본인확인을 먼저 해 주세요' },
};

async function problem<T>(p: () => Promise<T>): Promise<T> {
  try {
    return await p();
  } catch (e) {
    if (e instanceof VerificationError) {
      if (e.code === 'INVALID') throw new RequestValidationError(e.message);
      const def = PROBLEM[e.code as keyof typeof PROBLEM];
      if (def) throw new ProblemError({ ...def, ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}) });
    }
    // 대기열 Redis 일시 장애는 503과 짧은 Retry-After(1초 [가정])다(진입·입장 확정과 같다)
    if (e instanceof QueueStoreUnavailable) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: 1, cause: e });
    throw e;
  }
}

/** 키에 넣을 수 있는 회차·pid인지 본다. 회차가 틀리면 없는 대기열, pid가 없거나 틀리면 본인확인 필요(대기 취소와 같은 규칙) */
function who(eventId: string, me: Principal): { eventId: string; pid: string; pidPrev?: string } {
  if (!KEY_PART.test(eventId)) throw new VerificationError('NOT_FOUND', '회차 ID 모양이 틀렸다');
  if (!me.pid || !KEY_PART.test(me.pid)) throw new VerificationError('IDENTITY_VERIFICATION_REQUIRED', 'pid가 없다(본인확인 전)');
  if (me.pidPrev !== undefined && !KEY_PART.test(me.pidPrev)) throw new VerificationError('IDENTITY_VERIFICATION_REQUIRED', '옛 pid 모양이 틀렸다');
  return me.pidPrev && me.pidPrev !== me.pid ? { eventId, pid: me.pid, pidPrev: me.pidPrev } : { eventId, pid: me.pid };
}

const ASN = /^\d{1,10}$/;
const CLIENT_HINTS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'] as const;
const headerOf = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** 게이트웨이가 넘긴 요청 정보(사람 확인 서버 검증의 remoteip). 사전 검증과 같은 규칙: x-forwarded-for의 첫 값, ASN은 숫자만, 낮은 엔트로피 Client Hints만 */
function clientOf(reply: FastifyReply): VerificationClient {
  const h = reply.request.headers;
  const asnRaw = headerOf(h['cloudfront-viewer-asn']) ?? '';
  const clientHints: Record<string, string> = {};
  for (const name of CLIENT_HINTS) {
    const v = headerOf(h[name]);
    if (v !== undefined) clientHints[name] = v.slice(0, 256);
  }
  return { ip: (headerOf(h['x-forwarded-for']) ?? '').split(',')[0]!.trim(), userAgent: (headerOf(h['user-agent']) ?? '').slice(0, 512), asn: ASN.test(asnRaw) ? Number(asnRaw) : 0, clientHints };
}

@Controller('v1/queues/:eventId')
export class VerificationController {
  constructor(
    private readonly submitVerification: SubmitVerification,
    private readonly submitAppeal: SubmitAppeal,
    private readonly readVerification: ReadVerification,
  ) {}

  @Get('verification')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @ContractRouteSchema({ responses: { 200: QueueVerificationState } })
  async read(@Param('eventId') eventId: string, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return problem(() => this.readVerification.run(who(eventId, me)));
  }

  @Post('verification')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @ContractRouteSchema({ responses: { 200: QueueVerificationResult, 202: QueueVerificationAppealReceipt } })
  @HttpCode(200)
  async submit(@Param('eventId') eventId: string, @ContractBody(SubmitBody) body: z.output<typeof SubmitBody>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return problem(async () => {
      const c = { ...who(eventId, me), accountId: me.accountId };
      if (body.appeal !== undefined) {
        const out = await this.submitAppeal.run({ ...c, text: body.appeal });
        if (out.kind === 'PASSED') {
          const { kind: _kind, ...passed } = out;
          return passed;
        }
        void reply.code(202);
        return { appealId: out.appealId, receivedAt: out.receivedAt };
      }
      return this.submitVerification.run({ ...c, challengeToken: body.challengeToken!, ...(body.deviceId ? { deviceId: body.deviceId } : {}), client: clientOf(reply) });
    });
  }
}
