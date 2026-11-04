// 받는 층: 사전 검증 토큰 발급·대기열 진입(openapi /v1/queues/{eventId}/pre-verifications·entries, docs/features/queue-admission.md §3).
// 팬 경로라 게이트웨이가 넘긴 신원(계정·pid)과 구매 권한(ticket:buy)을 쓴다. 진입은 사전 요청이 없도록 text/plain 본문도 받는다(ADR-0065 결정 6).
// 응답은 캐시하지 않는다.
import { Controller, HttpCode, Param, Post, Res } from '@nestjs/common';
import { AcceptTextPlain, ContractBody, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { EnterQueue } from '../application/enter-queue.js';
import { EntryError } from '../application/entry-error.js';
import { IssuePreverification } from '../application/issue-preverification.js';
import { QueueStoreUnavailable } from '../domain/queue.js';

// openapi 요청 본문 모양(계약 생성물의 작업별 스키마 이름이 operationId 정리(wbs 0.2.3) 뒤 바뀌므로 여기 같은 모양으로 둔다)
const BehaviorSummary = z
  .object({
    v: z.literal(1),
    windowMs: z.int().min(0).max(3_600_000),
    pointerMoves: z.int().min(0).optional(),
    pointerEntropy: z.number().min(0).optional(),
    inputIntervalMeanMs: z.number().min(0).optional(),
    inputIntervalStdMs: z.number().min(0).optional(),
    scrollEvents: z.int().min(0).optional(),
    scrollDistancePx: z.int().min(0).optional(),
  })
  .strict();
const PreverifyBody = z.object({ humanCheckToken: z.string().max(4096).optional(), deviceId: z.string().max(128).optional(), preverifyToken: z.string().max(4096).optional(), behaviorSummary: BehaviorSummary.optional() });
const EntryBody = z.object({ preverifyToken: z.string().max(4096), deviceId: z.string().max(128).optional(), entryRequestId: z.uuid().optional() });

/** Redis 키의 해시 태그 안에 들어가는 값(회차 ID·pid)의 모양 */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;

const PROBLEM: Record<EntryError['code'], { status: number; type: string; title: string }> = {
  NOT_FOUND: { status: 404, type: 'queue-not-found', title: '이 회차의 대기열이 열리지 않았습니다' },
  NOT_OPEN: { status: 409, type: 'queue-not-open', title: '아직 예매가 열리지 않았습니다' },
  SALE_ENDED: { status: 410, type: 'sale-ended', title: '판매 시간이 끝났습니다' },
  BATCHING: { status: 503, type: 'batching', title: '순서를 정하는 중입니다. 잠시 뒤 다시 시도해 주세요' },
  QUEUE_RECOVERING: { status: 503, type: 'queue-recovering', title: '대기열을 다시 맞추는 중입니다. 잠시 뒤 다시 시도해 주세요' },
  PREVERIFY_INVALID: { status: 403, type: 'preverify-invalid', title: '사람 확인을 다시 해 주세요' },
  ALREADY_ADMITTED: { status: 409, type: 'already-admitted', title: '이 회차에 이미 입장했습니다' },
  ALREADY_WAITING: { status: 409, type: 'already-waiting', title: '이미 다른 곳에서 대기 중입니다' },
  IDENTITY_VERIFICATION_REQUIRED: { status: 403, type: 'identity-verification-required', title: '휴대폰 본인확인을 먼저 해 주세요' },
};

async function problem<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof EntryError) throw new ProblemError({ ...PROBLEM[e.code], ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}) });
    // 대기열 Redis 일시 장애는 503과 짧은 Retry-After(1초 [가정])로 답한다. 화면은 같은 진입 요청 ID로 다시 보낸다(openapi 진입 503)
    if (e instanceof QueueStoreUnavailable) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '대기열을 잠시 쓸 수 없습니다', retryAfterSeconds: 1, cause: e });
    throw e;
  }
}

/** 키에 넣을 수 있는 회차·pid인지 본다. 회차가 틀리면 없는 대기열, pid가 없거나 틀리면 본인확인 필요.
 * pid 키 전환 기간의 옛 pid(X-User-Pid-Prev)도 같은 모양이어야 하고, pid와 같으면 버린다(§3 'pid 키 전환 기간'의 첫 구현) */
function who(eventId: string, me: Principal): { pid: string; pidPrev?: string } {
  if (!KEY_PART.test(eventId)) throw new EntryError('NOT_FOUND', '회차 ID 모양이 틀렸다');
  if (!me.pid || !KEY_PART.test(me.pid)) throw new EntryError('IDENTITY_VERIFICATION_REQUIRED', 'pid가 없다(본인확인 전)');
  if (me.pidPrev !== undefined && !KEY_PART.test(me.pidPrev)) throw new EntryError('IDENTITY_VERIFICATION_REQUIRED', '옛 pid 모양이 틀렸다');
  return me.pidPrev && me.pidPrev !== me.pid ? { pid: me.pid, pidPrev: me.pidPrev } : { pid: me.pid };
}

@Controller('v1/queues/:eventId')
export class QueueController {
  constructor(
    private readonly issuePreverification: IssuePreverification,
    private readonly enterQueue: EnterQueue,
  ) {}

  @Post('pre-verifications')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @HttpCode(201)
  async preverify(@Param('eventId') eventId: string, @ContractBody(PreverifyBody) body: z.output<typeof PreverifyBody>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return problem((async () => this.issuePreverification.run({ accountId: me.accountId, eventId, body, ...who(eventId, me) }))());
  }

  @Post('entries')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @AcceptTextPlain()
  @HttpCode(201)
  async enter(@Param('eventId') eventId: string, @ContractBody(EntryBody) body: z.output<typeof EntryBody>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    const { kind, ...out } = await problem((async () => this.enterQueue.run({ accountId: me.accountId, eventId, body, ...who(eventId, me) }))());
    // 동시 도착 구간 묶음에 넣었으면 202 BATCHING(결과 파일 경로·공개 예정 시각·분산 창, ADR-0041·0058)
    if (kind === 'BATCHING') void reply.code(202);
    return out;
  }
}
