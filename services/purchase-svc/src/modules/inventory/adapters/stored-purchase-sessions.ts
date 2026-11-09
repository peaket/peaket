// 구매 세션 저장소 위의 플랫폼 구매 요청 인증 포트(resolve·advance)와 inventory의 세션 읽기(get) 운영 어댑터(BUILD_ORDER PRF-136,
// docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현'). MemoryPurchaseSessions(시험 대역)와 같은 PurchaseSessionAccess 면이다.
// resolve는 게이트웨이가 서명을 확인해 넘긴 입장 토큰(X-Admission-Token)의 jti로 구매 세션을 찾는다. 헤더의 jti는 조회 손잡이일 뿐이고 권한은 구매 세션 상태에 적힌 계정·로그인 세션이
// 요청의 신원과 같은지로 정한다(남의 jti를 넣어도 세션을 못 찾는다). 요청 인증 키는 저장하지 않고 요청마다 임시 공개키와 서버 ECDH 키로 다시 계산한다.
import type { Clock, Principal, PurchaseSession } from '@peaket/platform';
import { ProblemError, purchaseRequestKey } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { ADMISSION_TOKEN_MAX_CHARS } from '../domain/admission-token.js';
import { parseClientEphemeralKey } from '../domain/client-key.js';
import { KEY_PART, SEAT_STORE_RETRY_AFTER_SEC, SEAT_STORE_UNAVAILABLE_PROBLEM, SeatStoreUnavailable } from '../domain/hold.js';
import type { PurchaseSessionInfo, PurchaseSessionStore } from '../domain/ports.js';
import { sessionStoreErrorOf } from '../domain/purchase-session.js';
import type { PurchaseSessionAccess } from './memory-purchase-sessions.js';
import type { ServerEcdhKey } from './server-ecdh.js';

export const ADMISSION_TOKEN_HEADER = 'x-admission-token';
const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * 저장소 오류를 받는 층의 모양으로 바꿔 던진다: 좌석 Redis 일시 장애·메모리 부족(SeatStoreUnavailable)은 503 seat-store-unavailable(ProblemError, 까닭은 싣지 않는다),
 * 키 이름이 든 오류 글(PEAKET_…·s:{…·s:jti·s:session)은 SessionStoreFailure(code만), 그 밖은 그대로 던진다
 */
function rethrown(err: unknown): never {
  // 본문·머리는 홀드 응답의 STORE_UNAVAILABLE(HOLD_PROBLEMS)과 같고 까닭('oom')은 싣지 않는다
  if (err instanceof SeatStoreUnavailable) throw new ProblemError({ ...SEAT_STORE_UNAVAILABLE_PROBLEM, status: 503, retryAfterSeconds: SEAT_STORE_RETRY_AFTER_SEC, cause: err });
  throw sessionStoreErrorOf(err);
}

/** get용: SeatStoreUnavailable은 그대로(홀드 유스케이스가 바꾼다), 키 이름이 든 오류 글만 지운다 */
function sanitizedOnly(err: unknown): never {
  if (err instanceof SeatStoreUnavailable) throw err;
  return rethrown(err);
}

export interface StoredPurchaseSessionsDeps {
  store: PurchaseSessionStore;
  /** 서버 고정 ECDH 키(공유 비밀만 쓴다) */
  ecdh: Pick<ServerEcdhKey, 'sharedSecret'>;
  clock: Clock;
}

/** 헤더 값에서 입장 토큰의 jti를 꺼낸다(서명은 보지 않는다). 모양이 틀리면 undefined */
export function admissionJtiOf(header: unknown): string | undefined {
  if (typeof header !== 'string' || header.length > ADMISSION_TOKEN_MAX_CHARS) return undefined;
  const parts = header.split('.');
  // 서명은 게이트웨이가 확인했다. 여기서는 세 조각이 모두 채움 없는 base64url 모양인지만 본다(깨진 머리를 조회 손잡이로 쓰지 않는다)
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return undefined;
  try {
    const body: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
    const jti = (body as { jti?: unknown }).jti;
    return typeof jti === 'string' && KEY_PART.test(jti) ? jti : undefined;
  } catch {
    return undefined;
  }
}

/**
 * - resolve: 입장 토큰 헤더(하나, 2048자 이하)의 jti → 구매 세션 상태 읽기(한 번) → 계정·로그인 세션이 principal과 같고 최대 체류 앞이면
 *   { ref: jti, key: HKDF(ECDH(서버 개인키, 저장된 임시 공개키), salt = jti) }. 하나라도 어긋나거나 저장된 임시 공개키가 곡선 위의 점이 아니면 undefined(가드가 401)다.
 *   일련번호는 올리지 않는다. 저장소 장애(SeatStoreUnavailable)는 503 seat-store-unavailable ProblemError로 바꿔 던진다(PRF-136 리뷰. 훅이 그대로 낸다)
 * - advance: 저장소의 일련번호 올리기. ref가 키 조각 모양이 아니거나 seq가 1 이상의 안전한 정수가 아니면 저장소를 부르지 않고 false. 저장소 장애는 resolve와 같이 503
 *   (쓰였는지 모른다: 클라이언트는 다음 요청에 더 큰 번호를 쓴다)
 * - get: ref(= 구매 세션 ID = jti)의 상태. 없거나 최대 체류가 지났거나 ref 모양이 틀리면 undefined. 저장소 장애는 SeatStoreUnavailable 그대로 던진다
 *   (홀드 유스케이스가 STORE_UNAVAILABLE 503으로 바꾼다). 쓰기 전 지킴 오류는 resolve·advance·get 모두 SessionStoreFailure(code만)로 바꿔 던진다
 */
export class StoredPurchaseSessions implements PurchaseSessionAccess {
  constructor(private readonly deps: StoredPurchaseSessionsDeps) {}

  async resolve(request: FastifyRequest, principal: Principal): Promise<PurchaseSession | undefined> {
    const jti = admissionJtiOf(request.headers[ADMISSION_TOKEN_HEADER]);
    if (jti === undefined) return undefined;
    const s = await this.deps.store.read(jti).catch(rethrown);
    if (!s || s.accountId !== principal.accountId || s.loginSessionId !== principal.sessionId) return undefined;
    if (this.deps.clock.now() >= s.maxStayUntilMs) return undefined;
    const client = parseClientEphemeralKey(s.clientKey);
    if (!client) return undefined;
    return { ref: jti, key: purchaseRequestKey(this.deps.ecdh.sharedSecret(client.key), jti) };
  }

  async advance(ref: string, seq: number): Promise<boolean> {
    if (typeof ref !== 'string' || !KEY_PART.test(ref) || !Number.isSafeInteger(seq) || seq < 1) return false;
    return this.deps.store.advance(ref, seq).catch(rethrown);
  }

  async get(sessionId: string): Promise<PurchaseSessionInfo | undefined> {
    if (typeof sessionId !== 'string' || !KEY_PART.test(sessionId)) return undefined;
    const s = await this.deps.store.read(sessionId).catch(sanitizedOnly);
    if (!s || this.deps.clock.now() >= s.maxStayUntilMs) return undefined;
    return { sessionId: s.sessionId, accountId: s.accountId, eventId: s.eventId, journeyId: s.journeyId };
  }
}
