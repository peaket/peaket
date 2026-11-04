// 구매 세션 열기(BUILD_ORDER PRF-136, docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', ADR-0183 결정 8·11).
// 입장 토큰을 처음 쓰는 요청(스냅샷 API, PRF-137)에서 부른다. 차례: 입장 토큰 확인 → 요청의 계정·로그인 세션·회차와 대조 → 클라이언트 임시 공개키 검사 →
// 저장소에서 열기 → SESSION_STARTED를 따로 더하고 기록 표시를 한다. 새로 열렸거나, 열린 지 1초가 지났는데 아직 기록 표시가 없을 때(더하기가 실패했거나 응답을 잃은 재시도)만 더한다
// (더하기·표시 실패는 로그만 남기고 열기는 성공이다. 표시가 없는 REPLAY가 다시 더하므로 중복 항목이 생길 수 있고, 같은 사건은 eventKey가 같아 받는 쪽이 거른다, ADR-0052).
// 거절은 OpenSessionError(code)다: 받는 층(PRF-137)이 TOKEN_*·FIRST_USE_EXPIRED·TOKEN_USED는 401, EVENT_MISMATCH는 403, CLIENT_KEY_INVALID는 400으로 바꾼다.
// 거절 이유는 로그에만 남긴다(응답에 싣지 않는다, ASVS 16.3.1). 로그에는 이유·갈래·주소의 회차만 싣고 토큰·계정·세션 ID·공개키는 싣지 않는다(ASVS 16.2.5).
import type { Clock } from '@peaket/platform';
import { AdmissionTokenRejected, type AdmissionKeys, FIRST_USE_MS, verifyAdmissionToken } from '../domain/admission-token.js';
import { parseClientEphemeralKey } from '../domain/client-key.js';
import type { PurchaseSessionStore, SessionStartedLog } from '../domain/ports.js';
import { sessionStoreErrorOf } from '../domain/purchase-session.js';

export type OpenSessionErrorCode =
  /** 서명·typ·aud·iss·kid·모양·iat가 틀린 입장 토큰 (401) */
  | 'TOKEN_INVALID'
  /** 입장 토큰 exp가 지났다 (401) */
  | 'TOKEN_EXPIRED'
  /** 구매 세션이 아직 없는데 iat + 5분이 지났다 (401) */
  | 'FIRST_USE_EXPIRED'
  /** 토큰의 계정·로그인 세션이 요청과 다르다. 남의 토큰이다 (401) */
  | 'TOKEN_MISMATCH'
  /** 주소의 회차가 토큰의 event와 다르다 (403) */
  | 'EVENT_MISMATCH'
  /** 클라이언트 임시 공개키가 없거나 모양이 틀리거나 곡선 위의 점이 아니다 (400) */
  | 'CLIENT_KEY_INVALID'
  /** 이미 쓴 입장 토큰이다: 다른 임시 공개키·계정·회차로 다시 열었거나 끝난 세션에 다시 열었다 (401) */
  | 'TOKEN_USED';

export class OpenSessionError extends Error {
  constructor(readonly code: OpenSessionErrorCode) {
    super(`구매 세션 열기 거절: ${code}`);
    this.name = 'OpenSessionError';
  }
}

export interface OpenSessionLogger {
  warn(obj: object, msg: string): void;
}

export interface OpenPurchaseSessionDeps {
  store: PurchaseSessionStore;
  log: SessionStartedLog;
  /** 입장 토큰 공개키 묶음(PEAKET_ADMISSION_JWKS) */
  keys: AdmissionKeys;
  /** 입장 토큰 발급자(PEAKET_ADMISSION_ISSUER) */
  issuer: string;
  clock: Clock;
  logger?: OpenSessionLogger;
}

export interface OpenSessionCommand {
  /** X-Admission-Token 머리 값 */
  token: unknown;
  /** 요청의 신원(게이트웨이 내부 머리에서 온 Principal) */
  accountId: string;
  loginSessionId: string;
  /** 주소의 회차 */
  eventId: string;
  /** X-Client-Ephemeral-Key 머리 값 */
  clientKey: unknown;
}

export interface OpenSessionOutcome {
  /** 구매 세션 ID = 입장 토큰 jti */
  sessionId: string;
  eventId: string;
  journeyId: string;
  /** 이번 요청이 세션을 새로 만들었는지(false면 응답을 잃은 재시도) */
  created: boolean;
  startedAtMs: number;
  /** 세션의 최대 체류. 새로 열었으면 이 토큰의 exp, 아니면 세션에 적힌 처음 값이다(같은 jti로 다시 받은 토큰의 더 늦은 exp가 아니다) */
  maxStayUntilMs: number;
  priorityGrantId?: string;
}

export class OpenPurchaseSession {
  constructor(private readonly deps: OpenPurchaseSessionDeps) {}

  /**
   * @throws OpenSessionError 위 갈래
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애·메모리 부족(받는 층이 503으로 답한다. 쓰였는지 모르지만 같은 입력으로 다시 부르면 REPLAY나 CREATED다)
   * @throws SessionStoreFailure 열기 Lua의 쓰기 전 지킴 오류(PEAKET_CORRUPT_KEY …). 키 이름(구매 세션 ID)을 지우고 code만 담는다(ASVS 16.2.5)
   * @throws Error 스크립트 오류 같은 버그
   */
  async execute(c: OpenSessionCommand): Promise<OpenSessionOutcome> {
    const now = this.deps.clock.now();
    let claims;
    try {
      claims = verifyAdmissionToken(c.token, { keys: this.deps.keys, issuer: this.deps.issuer, nowMs: now });
    } catch (e) {
      if (e instanceof AdmissionTokenRejected) throw this.#reject(e.reason === 'expired' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID', c.eventId, e.reason);
      throw e;
    }
    if (claims.accountId !== c.accountId || claims.loginSessionId !== c.loginSessionId) throw this.#reject('TOKEN_MISMATCH', c.eventId, 'principal');
    if (claims.eventId !== c.eventId) throw this.#reject('EVENT_MISMATCH', c.eventId, 'event');
    const client = parseClientEphemeralKey(c.clientKey);
    if (!client) throw this.#reject('CLIENT_KEY_INVALID', c.eventId, 'client_key');

    const r = await this.deps.store
      .open({
        jti: claims.jti,
        accountId: claims.accountId,
        loginSessionId: claims.loginSessionId,
        eventId: claims.eventId,
        journeyId: claims.journeyId,
        clientKey: client.text,
        expiresAtMs: claims.expiresAtMs,
        firstUseDeadlineMs: claims.issuedAtMs + FIRST_USE_MS,
        // queue-svc가 자리가 살아 있는 동안 같은 jti로 다시 주는 토큰의 exp는 새 iat + 최대 체류(= exp − iat)이고 새 iat은 이 exp 앞이라, 가장 늦은 exp는 exp + (exp − iat)다
        reissueUntilMs: claims.expiresAtMs + (claims.expiresAtMs - claims.issuedAtMs),
        ...(claims.priorityGrantId !== undefined ? { priorityGrantId: claims.priorityGrantId } : {}),
      })
      .catch((e: unknown) => {
        throw sessionStoreErrorOf(e);
      });
    switch (r.kind) {
      case 'TOKEN_EXPIRED':
        throw this.#reject('TOKEN_EXPIRED', c.eventId, 'expired');
      case 'FIRST_USE_EXPIRED':
        throw this.#reject('FIRST_USE_EXPIRED', c.eventId, 'first_use_expired');
      case 'MISMATCH':
        throw this.#reject('TOKEN_USED', c.eventId, 'used');
      case 'ENDED':
        throw this.#reject('TOKEN_USED', c.eventId, 'ended');
      case 'CREATED':
      case 'REPLAY':
        break;
    }
    const maxStayUntilMs = r.kind === 'REPLAY' ? r.maxStayUntilMs : claims.expiresAtMs;
    if (r.kind === 'CREATED' || r.needsStarted) await this.#started(claims.eventId, claims.jti, claims.journeyId, r.startedAtMs, maxStayUntilMs);
    return {
      sessionId: claims.jti,
      eventId: claims.eventId,
      journeyId: claims.journeyId,
      created: r.kind === 'CREATED',
      startedAtMs: r.startedAtMs,
      maxStayUntilMs,
      ...(claims.priorityGrantId !== undefined ? { priorityGrantId: claims.priorityGrantId } : {}),
    };
  }

  /**
   * SESSION_STARTED를 더하고 기록 표시를 한다. 실패해도 열기는 성공이다: 더하기가 실패하면 표시가 없어 다음 REPLAY가 다시 더하고,
   * 표시가 실패하면 다음 REPLAY가 한 번 더 더한다(중복 항목은 eventKey로 거른다). 끝까지 빠지면 입장 자리 5분 회수와 최대 체류 정리가 덮는다
   */
  async #started(eventId: string, jti: string, journeyId: string, startedAtMs: number, maxStayUntilMs: number): Promise<void> {
    try {
      await this.deps.log.appendStarted({ eventId, purchaseSessionId: jti, admissionJti: jti, journeyId, startedAtMs, maxStayUntilMs });
    } catch (err) {
      this.deps.logger?.warn({ eventId, errorName: err instanceof Error ? err.name : typeof err }, 'SESSION_STARTED 더하기 실패');
      return;
    }
    try {
      await this.deps.store.markStarted(jti);
    } catch (err) {
      this.deps.logger?.warn({ eventId, errorName: err instanceof Error ? err.name : typeof err }, 'SESSION_STARTED 기록 표시 실패');
    }
  }

  #reject(code: OpenSessionErrorCode, eventId: string, reason: string): OpenSessionError {
    // 거절 이유(reason)는 TOKEN_INVALID·TOKEN_EXPIRED일 때 입장 토큰 확인의 이유 그대로, 그 밖에는 저장소/대조의 이유다
    this.deps.logger?.warn({ reason, code, eventId }, '구매 세션 열기 거절');
    return new OpenSessionError(code);
  }
}
