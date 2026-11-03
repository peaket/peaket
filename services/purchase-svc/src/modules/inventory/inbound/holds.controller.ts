// 받는 층: 좌석 홀드(openapi POST /v1/events/{eventId}/holds, docs/features/seat-hold.md §3). 팬 경로라 게이트웨이가 넘긴 신원(계정)과
// 구매 권한(ticket:buy)을 쓰고, 계정은 플랫폼 인증 가드의 신원으로만 정한다. 응답은 캐시하지 않는다.
// 검사 차례(플랫폼 인증 가드): 신원 → 역할·스코프 → 멱등 키 형식(400 idempotency-key-invalid) → 구매 요청 서명(401) → 경로 스키마(400) → 처리기.
// 핫패스라 Zod 파이프가 아니라 경로 스키마(@ContractRouteSchema, 미리 만든 Ajv 검사기)로 본다(ADR-0176 결정 4). 같은 처리기에 Zod 파이프를 함께 달지 않는다.
import { Body, Controller, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  ContractRouteSchema,
  CurrentPrincipal,
  CurrentPurchaseSession,
  IdempotencyRequest,
  Idempotent,
  LogPolicy,
  type Principal,
  PurchaseSigned,
  Roles,
  requestLog,
} from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { HoldError, throwHoldProblem } from '../application/hold-error.js';
import { type HoldResponse, HoldSeats } from '../application/hold-seats.js';
import { KEY_PART, MAX_SEATS, SEAT_ID_PATTERN } from '../domain/hold.js';

/** 멱등 작업 이름(범위 = 계정 × 이 작업, guidelines §4). 홀드의 멱등 기록은 PostgreSQL이 아니라 좌석 Redis의 홀드 Lua 안이다 */
export const HOLD_OPERATION = 'HOLD_SEATS';
/** NFR-003 홀드 p99 50ms */
const HOLD_SLO_MS = 50;

// openapi 모양을 여기 둔다(계약 생성물의 작업별 스키마 이름이 operationId 정리(wbs 0.2.3) 뒤 바뀌므로, queue-svc와 같은 방식).
// 회차 ID는 Redis 키의 해시 태그에 들어가므로 모양을 묻는다(틀리면 400).
export const HoldParams = z.object({ eventId: z.string().regex(KEY_PART) }).strict();

/** 계약 머리. 세 칸 모두 플랫폼 모듈이 보고(멱등 키·구매 요청 서명) 경로 스키마에서는 빠진다. 여기 두는 것은 시작 확인(@Idempotent·@PurchaseSigned 요구)을 걸기 위해서다 */
export const HoldHeaders = z.object({
  'Idempotency-Key': z.uuid(),
  'X-Purchase-Seq': z.int().min(1),
  'X-Purchase-Mac': z.string(),
});

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

/**
 * 본문 HoldRequest. seatIds는 1~10개, 좌석 ID 모양 SEAT_ID_PATTERN(어기면 400). 같은 좌석 두 번은 여기서 막지 않고 쓰임새가 422 invalid-seat로 답한다
 * (seat-hold.md §3 '좌석 ID 확인', S-T30 ④). auto는 모양만 받고 쓰임새가 400 auto-assign-not-supported로 거절한다(자동 배정은 wbs 2.5.4).
 * seatIds와 auto 가운데 하나만 보내는 규칙도 쓰임새가 본다
 */
export const HoldRequest = z.object({
  seatIds: z.array(z.string().regex(SEAT_ID_PATTERN)).min(1).max(MAX_SEATS).optional(),
  auto: z
    .object({
      firstTierId: z.string(),
      secondTierId: z.string().optional(),
      count: z.int().min(1),
      wheelchair: z.boolean().default(false),
      allowSplit: z.boolean().default(false),
    })
    .optional(),
  clientEphemeralPublicKey: z.string().optional(),
  behavior: BehaviorSummary.optional(),
});
export type HoldRequest = z.output<typeof HoldRequest>;

/** 201 응답 Hold(직렬화 스키마. 스키마에 없는 칸은 내보내지 않는다) */
export const HoldResponseBody = z.object({
  holdId: z.string(),
  seatIds: z.array(z.string()),
  expiresAt: z.iso.datetime(),
  extendable: z.boolean(),
  fencingToken: z.int().min(1),
  assignResult: z.enum(['FIRST', 'FIRST_SPLIT', 'SECOND', 'SECOND_SPLIT']).optional(),
});

@Controller('v1/events/:eventId')
export class HoldsController {
  constructor(private readonly holdSeats: HoldSeats) {}

  /**
   * 좌석 홀드. 처리는 HoldSeats.execute 하나이고, HoldError는 throwHoldProblem이 대응표대로 HTTP 오류로 바꾼다. 그 밖의 오류는 그대로(500).
   * 응답: 201 Hold, Cache-Control: no-store(오류 응답도).
   */
  @Post('holds')
  @HttpCode(201)
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @Idempotent({ operation: HOLD_OPERATION })
  @PurchaseSigned()
  @LogPolicy({ sloLatencyMs: HOLD_SLO_MS })
  @ContractRouteSchema({ params: HoldParams, headers: HoldHeaders, body: HoldRequest, responses: { 201: HoldResponseBody } })
  async hold(
    @Param('eventId') eventId: string,
    @Body() body: HoldRequest,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() idem: IdempotencyRequest,
    @CurrentPurchaseSession() purchaseSessionId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<HoldResponse> {
    requestLog().set({ queuePhase: 'purchase' });
    void reply.header('cache-control', 'no-store');
    try {
      return await this.holdSeats.execute({ eventId, accountId: me.accountId, purchaseSessionId, idempotencyKey: idem.key, body });
    } catch (e) {
      if (e instanceof HoldError) throwHoldProblem(e, reply);
      throw e;
    }
  }
}
