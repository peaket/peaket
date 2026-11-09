// 받는 층: 좌석 스냅샷(openapi GET /v1/events/{eventId}/seatmap-snapshot, docs/features/seat-hold.md §2 '스냅샷 API의 첫 구현', BUILD_ORDER PRF-137).
// 팬 경로(역할 fan)이고 구매 세션 요청 서명은 없다(첫 사용 요청이라 구매 세션이 아직 없다). 입장 토큰은 ReadSeatSnapshot이 확인한다.
// 거절 바꾸기: OpenSessionError TOKEN_INVALID·TOKEN_EXPIRED·FIRST_USE_EXPIRED·TOKEN_MISMATCH·TOKEN_USED 401(WWW-Authenticate COOKIE_CHALLENGE, 이름 없는 본문),
// EVENT_MISMATCH 403, CLIENT_KEY_INVALID 400(이름 없는 본문). SnapshotError NOT_READY 503 seat-store-unavailable + Retry-After, SECTION_OUT_OF_RANGE 400.
// SeatStoreUnavailable 503(까닭은 싣지 않는다). 그 밖의 오류는 키 이름을 지워(sanitizedStoreError) 던진다. 응답: 200 application/octet-stream, no-store(오류도).
// 경로 스키마(@ContractRouteSchema)가 주소의 회차 ID 모양(KEY_PART)과 section(정수 0 ~ 65535, 한 번만)을 본다 — 틀리면 400이다(ASVS 15.3.7).
import { ForbiddenException, Controller, Get, Headers, Inject, Optional, Param, Query, Res, UnauthorizedException } from '@nestjs/common';
import {
  COOKIE_CHALLENGE,
  ContractRouteSchema,
  CurrentPrincipal,
  PLATFORM_LOGGER,
  type PlatformLogger,
  type Principal,
  RequestValidationError,
  Roles,
  requestContext,
  requestLog,
} from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { HoldError, storeUnavailableError, throwHoldProblem } from '../application/hold-error.js';
import { type LogGate, OOM_WARN_GATE } from '../application/log-gate.js';
import { OpenSessionError } from '../application/open-purchase-session.js';
import { ReadSeatSnapshot, SnapshotError } from '../application/read-seat-snapshot.js';
import { KEY_PART, SeatStoreUnavailable } from '../domain/hold.js';
import { U16_MAX } from '../domain/snapshot.js';
import { sanitizedStoreError } from './holds.controller.js';

export const SnapshotParams = z.object({ eventId: z.string().regex(KEY_PART) }).strict();
/** 쿼리 section: 정수 0 ~ 65535, 한 번만(두 번 오면 배열이라 정수가 아니어서 400, ASVS 15.3.7) */
export const SnapshotQuery = z.object({ section: z.int().min(0).max(U16_MAX).optional() }).strict();
/** 머리는 둘 다 선택이다(첫 사용 요청에만 임시 공개키가 필수이고 그 판단은 쓰임새가 한다) */
export const SnapshotHeaders = z.object({ 'X-Client-Ephemeral-Key': z.string().optional() });

@Controller('v1/events/:eventId')
export class SnapshotController {
  constructor(
    private readonly snapshot: ReadSeatSnapshot,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
    /** 메모리 부족 경고 문(파드마다 1초에 한 줄, 홀드·만료와 같은 문) */
    @Optional() @Inject(OOM_WARN_GATE) private readonly oomGate?: LogGate,
  ) {}

  /**
   * 좌석 스냅샷. 200 이진 본문(docs/frontend.md §4.4.2), Cache-Control: no-store(오류도).
   * 요청 머리 `X-Admission-Token`(입장 토큰)은 하나만 받는다(Fastify가 같은 머리를 쉼표로 이어 주면 입장 토큰 확인이 모양 오류로 거절한다).
   */
  @Get('seatmap-snapshot')
  @Roles(['fan'])
  @ContractRouteSchema({ params: SnapshotParams, query: SnapshotQuery, headers: SnapshotHeaders })
  async get(
    @Param('eventId') eventId: string,
    @Query('section') section: number | undefined,
    @Headers('x-admission-token') token: unknown,
    @Headers('x-client-ephemeral-key') clientKey: unknown,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requestLog().set({ queuePhase: 'purchase' });
    void reply.header('cache-control', 'no-store');
    try {
      const deadline = requestContext()?.deadline;
      const body = await this.snapshot.execute({
        eventId,
        accountId: me.accountId,
        loginSessionId: me.sessionId,
        token,
        clientKey,
        section,
        ...(deadline ? { deadline } : {}),
      });
      void reply.header('content-type', 'application/octet-stream');
      return body;
    } catch (e) {
      throw this.#problem(e, reply);
    }
  }

  /** 오류를 받는 층의 모양으로 바꾼다(던지지 않고 돌려준다) */
  #problem(e: unknown, reply: FastifyReply): unknown {
    if (e instanceof OpenSessionError) {
      switch (e.code) {
        case 'EVENT_MISMATCH':
          return new ForbiddenException();
        case 'CLIENT_KEY_INVALID':
          return new RequestValidationError('임시 공개키 머리가 없거나 모양이 틀리다');
        default:
          void reply.header('www-authenticate', COOKIE_CHALLENGE);
          return new UnauthorizedException();
      }
    }
    if (e instanceof SnapshotError) {
      if (e.code === 'SECTION_OUT_OF_RANGE') return new RequestValidationError('section이 판의 구역 수 밖이다');
      return this.#hold(new HoldError('NOT_READY', '그 회차의 좌석 스냅샷을 읽을 수 없다'), reply);
    }
    if (e instanceof SeatStoreUnavailable) {
      const he = storeUnavailableError(e);
      if (e.reason === 'oom' && (this.oomGate?.allow() ?? true)) this.logger?.warn({ seatStoreReason: 'oom' }, '좌석 Redis 메모리 부족으로 스냅샷을 503으로 답했다');
      return this.#hold(he, reply);
    }
    return sanitizedStoreError(e);
  }

  /** HoldError를 대응표대로 문제 상세로 바꾼다(throwHoldProblem은 던지므로 그 오류를 잡아 돌려준다) */
  #hold(e: HoldError, reply: FastifyReply): unknown {
    try {
      throwHoldProblem(e, reply);
    } catch (problem) {
      return problem;
    }
    return e;
  }
}
