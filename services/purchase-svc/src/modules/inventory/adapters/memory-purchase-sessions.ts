// 시험용 구매 세션 대역. 실제 구매 세션(s:jti·s:session, 입장 토큰 확인, SESSION_STARTED)은 stored-purchase-sessions.ts·redis-purchase-sessions.ts다(PRF-136).
// 플랫폼 구매 요청 인증 훅의 포트(resolve·advance)와 inventory의 세션 읽기(get)를 함께 맡는 PurchaseSessionAccess 면은 둘이 같다.
import type { Principal, PurchaseSession, PurchaseSessionPort } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { PURCHASE_SESSION_INFO, type PurchaseSessionInfo, type PurchaseSessions } from '../domain/ports.js';

/** 구매 세션 구현이 함께 맡는 두 면: 플랫폼 구매 요청 인증 훅의 포트(resolve·advance)와 inventory의 세션 읽기(get) */
export type PurchaseSessionAccess = PurchaseSessions & PurchaseSessionPort;

/** 대역에 여는 구매 세션 하나 */
export interface MemoryPurchaseSession extends PurchaseSessionInfo {
  /** 이 구매 세션을 쓰는 로그인 세션(Principal.sessionId, 게이트웨이 x-session-id). 대역은 이것과 계정으로 요청의 구매 세션을 찾는다 */
  loginSessionId: string;
  /** 요청 인증 키(HMAC-SHA256 키, 32바이트) */
  key: Uint8Array;
  /** 마지막으로 받은 일련번호(기본 0) */
  lastSeq?: number;
}

/** PurchaseSessionAccess의 메모리 대역 */
export class MemoryPurchaseSessions implements PurchaseSessionAccess {
  readonly #sessions = new Map<string, MemoryPurchaseSession & { lastSeq: number }>();

  /** 구매 세션을 연다(같은 sessionId면 바꾼다). 같은 계정·로그인 세션에 다른 sessionId가 이미 열려 있으면 RangeError */
  open(s: MemoryPurchaseSession): void {
    for (const o of this.#sessions.values()) {
      if (o.sessionId !== s.sessionId && o.accountId === s.accountId && o.loginSessionId === s.loginSessionId) {
        throw new RangeError(`같은 계정·로그인 세션에 구매 세션이 이미 열려 있다: ${o.sessionId}`);
      }
    }
    this.#sessions.set(s.sessionId, { ...s, lastSeq: s.lastSeq ?? 0 });
  }

  /** 구매 세션을 끝낸다(없으면 아무 일도 없다). 끝난 세션은 resolve·get이 undefined */
  end(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /** 지금 마지막 일련번호(없는 세션은 undefined). 시험이 '서명이 틀리면 번호를 올리지 않는다'를 볼 때 쓴다 */
  lastSeq(sessionId: string): number | undefined {
    return this.#sessions.get(sessionId)?.lastSeq;
  }

  /** 플랫폼 포트: principal의 계정·로그인 세션에 열린 구매 세션이 있으면 { ref: sessionId, key }, 없으면 undefined(가드가 401) */
  async resolve(request: FastifyRequest, principal: Principal): Promise<PurchaseSession | undefined> {
    for (const s of this.#sessions.values()) {
      if (s.accountId !== principal.accountId || s.loginSessionId !== principal.sessionId) continue;
      (request as unknown as Record<symbol, PurchaseSessionInfo | undefined>)[PURCHASE_SESSION_INFO] = {
        sessionId: s.sessionId,
        accountId: s.accountId,
        eventId: s.eventId,
        journeyId: s.journeyId,
        ...(s.priorityGrantId !== undefined ? { priorityGrantId: s.priorityGrantId } : {}),
      };
      return { ref: s.sessionId, key: s.key };
    }
    return undefined;
  }

  /** 플랫폼 포트: seq가 그 세션의 마지막 번호보다 클 때만 올리고 true. 아니거나 세션이 없으면 false */
  async advance(ref: string, seq: number): Promise<boolean> {
    const s = this.#sessions.get(ref);
    if (!s || !(seq > s.lastSeq)) return false;
    s.lastSeq = seq;
    return true;
  }

  /** 열린 세션의 상태(PurchaseSessionInfo 칸만, 사본). 없거나 끝났으면 undefined */
  async get(sessionId: string): Promise<PurchaseSessionInfo | undefined> {
    const s = this.#sessions.get(sessionId);
    return s
      ? { sessionId: s.sessionId, accountId: s.accountId, eventId: s.eventId, journeyId: s.journeyId, ...(s.priorityGrantId !== undefined ? { priorityGrantId: s.priorityGrantId } : {}) }
      : undefined;
  }
}
