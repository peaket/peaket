// 받는 층: 사전 검증 토큰 발급·대기열 진입(openapi /v1/queues/{eventId}/pre-verifications·entries, docs/features/queue-admission.md §3).
// 팬 경로라 게이트웨이가 넘긴 신원(계정·pid)과 구매 권한(ticket:buy)을 쓴다. 진입은 사전 요청이 없도록 text/plain 본문도 받는다(ADR-0065 결정 6).
// 응답은 캐시하지 않는다.
import { Controller, Delete, HttpCode, Param, Post, Res } from '@nestjs/common';
import { AcceptTextPlain, ContractBody, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { EnterQueue } from '../application/enter-queue.js';
import { EntryError } from '../application/entry-error.js';
import { IssuePreverification } from '../application/issue-preverification.js';
import { JoinLobby } from '../application/join-lobby.js';
import { LeaveQueue } from '../application/leave-queue.js';
import type { RiskClient } from '../domain/ports.js';
import { ARRIVAL_COOKIE_NAME, ARRIVAL_UNSIGNED_HEADER, cookieValue, QueueStoreUnavailable } from '../domain/queue.js';

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
// 요청 본문은 계약처럼 닫는다(정하지 않은 칸은 400, docs/api/guidelines.md §1 '요청은 닫고 응답은 연다', BAS-040)
// deviceId: CSPRNG 128비트, base64url 22자(docs/frontend.md §3.12 peaket.device). 형식 밖 값으로 기기 이력을 더럽히지 못하게 위험 판정에 넘기기 전에 거절한다
const DeviceId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
// 사람 확인 토큰 상한은 관리 로그인 계약(openapi humanCheckToken maxLength 2048)과 같게 둔다. Cloudflare 문서의 값은 저장소 안에서 다시 확인하지 못해 [가정]이다
const HumanCheckToken = z.string().max(2048);
const PreverifyBody = z.object({ humanCheckToken: HumanCheckToken.optional(), deviceId: DeviceId.optional(), preverifyToken: z.string().max(4096).optional(), behaviorSummary: BehaviorSummary.optional() }).strict();
const LobbyBody = z.object({ humanCheckToken: HumanCheckToken.optional(), deviceId: DeviceId.optional() }).strict();
const EntryBody = z.object({ preverifyToken: z.string().max(4096), deviceId: z.string().max(128).optional(), entryRequestId: z.uuid().optional() }).strict();

/** Redis 키의 해시 태그 안에 들어가는 값(회차 ID·pid)의 모양 */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;

const PROBLEM: Record<EntryError['code'], { status: number; type: string; title: string }> = {
  NOT_FOUND: { status: 404, type: 'queue-not-found', title: '이 회차의 대기열이 열리지 않았습니다' },
  NOT_OPEN: { status: 409, type: 'queue-not-open', title: '아직 예매가 열리지 않았습니다' },
  SALE_ENDED: { status: 410, type: 'sale-ended', title: '판매 시간이 끝났습니다' },
  // 엣지 응답이 퍼지기 전에 원본에 온 진입(HOT-010, ADR-0122·0214)
  SOLD_OUT: { status: 410, type: 'sold-out', title: '매진되었습니다' },
  BATCHING: { status: 503, type: 'batching', title: '순서를 정하는 중입니다. 잠시 뒤 다시 시도해 주세요' },
  QUEUE_RECOVERING: { status: 503, type: 'queue-recovering', title: '대기열을 다시 맞추는 중입니다. 잠시 뒤 다시 시도해 주세요' },
  PREVERIFY_INVALID: { status: 403, type: 'preverify-invalid', title: '사람 확인을 다시 해 주세요' },
  ALREADY_ADMITTED: { status: 409, type: 'already-admitted', title: '이 회차에 이미 입장했습니다' },
  ALREADY_WAITING: { status: 409, type: 'already-waiting', title: '이미 다른 곳에서 대기 중입니다' },
  LOBBY_CLOSED: { status: 409, type: 'lobby-closed', title: '로비가 닫혔습니다' },
  LOBBY_PARTICIPANT_NOT_FOUND: { status: 404, type: 'lobby-participant-not-found', title: '로비 참가 기록이 없습니다' },
  // 취소한 참가의 재전송(처음 기기, ADR-0233). 입장 확정의 빠진 번호와 같은 type이라 화면은 '다른 기기에서 취소'로 끝낸다
  ENTRY_CANCELLED: { status: 410, type: 'queue-ticket-removed', title: '이 대기표는 더 쓸 수 없습니다' },
  IDENTITY_VERIFICATION_REQUIRED: { status: 403, type: 'identity-verification-required', title: '휴대폰 본인확인을 먼저 해 주세요' },
  // 위험 판정을 받지 못할 때의 파드 메모리 한도(docs/features/bot-defense.md §11.2). 축소 운영 중임을 드러내지 않는다
  DEGRADED_LIMITED: { status: 429, type: 'queue-request-limited', title: '요청이 많아 잠시 뒤 다시 시도해 주세요' },
};

async function problem<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof EntryError) throw new ProblemError({ ...PROBLEM[e.code], ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}) });
    // 대기열 Redis 일시 장애는 503과 짧은 Retry-After(1초 [가정])로 답한다. 화면은 같은 진입 요청 ID로 다시 보낸다(openapi 진입 503)
    if (e instanceof QueueStoreUnavailable) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: 1, cause: e });
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

const ASN = /^\d{1,10}$/;
const CLIENT_HINTS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'] as const;
const headerOf = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * 게이트웨이가 넘긴 요청 정보. x-forwarded-for는 입구가 클라이언트 IP 하나로 다시 쓴다(docs/infra.md). cloudfront-viewer-asn은 원본 확인 헤더가 맞는 요청에만 남는다(§3.3).
 * ASN이 숫자가 아니면 0이다(그 밖으로 본다, trust.proto). Client Hints는 낮은 엔트로피 셋만 받는다(지문을 모으지 않는다, ADR-0079 결정 5)
 */
function clientOf(reply: FastifyReply): RiskClient {
  const h = reply.request.headers;
  const asnRaw = headerOf(h['cloudfront-viewer-asn']) ?? '';
  const ip = (headerOf(h['x-forwarded-for']) ?? '').split(',')[0]!.trim();
  const clientHints: Record<string, string> = {};
  for (const name of CLIENT_HINTS) {
    const v = headerOf(h[name]);
    if (v !== undefined) clientHints[name] = v.slice(0, 256);
  }
  return { ip, userAgent: (headerOf(h['user-agent']) ?? '').slice(0, 512), asn: ASN.test(asnRaw) ? Number(asnRaw) : 0, clientHints };
}

@Controller('v1/queues/:eventId')
export class QueueController {
  constructor(
    private readonly issuePreverification: IssuePreverification,
    private readonly enterQueue: EnterQueue,
    private readonly joinLobby: JoinLobby,
    private readonly leaveQueue: LeaveQueue,
  ) {}

  // 팬 쿠키로 부르므로 처음 기기가 없어도 된다(ADR-0060). 경로에 ID가 없고 호출자 pid의 참가만 지운다
  @Delete('lobby-participants/me')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @HttpCode(204)
  async leaveLobby(@Param('eventId') eventId: string, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    await problem((async () => this.leaveQueue.lobby({ eventId, ...who(eventId, me) }))());
  }

  @Delete('entries/me')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @HttpCode(204)
  async leaveEntry(@Param('eventId') eventId: string, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    await problem((async () => this.leaveQueue.entry({ eventId, ...who(eventId, me) }))());
  }

  @Post('lobby-participants')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @HttpCode(201)
  async lobby(@Param('eventId') eventId: string, @ContractBody(LobbyBody) body: z.output<typeof LobbyBody>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return problem((async () => this.joinLobby.run({ accountId: me.accountId, eventId, body, ...who(eventId, me), client: clientOf(reply) }))());
  }

  @Post('pre-verifications')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @HttpCode(201)
  async preverify(@Param('eventId') eventId: string, @ContractBody(PreverifyBody) body: z.output<typeof PreverifyBody>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return problem((async () => this.issuePreverification.run({ accountId: me.accountId, eventId, body, ...who(eventId, me), client: clientOf(reply) }))());
  }

  @Post('entries')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @AcceptTextPlain()
  @HttpCode(201)
  async enter(@Param('eventId') eventId: string, @ContractBody(EntryBody) body: z.output<typeof EntryBody>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    const arrivalCookie = cookieValue(reply.request.headers.cookie, ARRIVAL_COOKIE_NAME);
    const arrivalUnsigned = reply.request.headers[ARRIVAL_UNSIGNED_HEADER] === 'unsigned';
    const { kind, ...out } = await problem((async () => this.enterQueue.run({ accountId: me.accountId, sessionId: me.sessionId, eventId, body, ...who(eventId, me), ...(arrivalCookie ? { arrivalCookie } : {}), ...(arrivalUnsigned ? { arrivalUnsigned } : {}) }))());
    // 동시 도착 구간 묶음에 넣었으면 202 BATCHING(결과 파일 경로·공개 예정 시각·분산 창, ADR-0041·0058)
    if (kind === 'BATCHING') void reply.code(202);
    return out;
  }
}
