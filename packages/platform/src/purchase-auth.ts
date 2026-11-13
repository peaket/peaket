// 구매 요청 인증 훅(ADR-0050 결정 8, docs/frontend.md §5.3, openspec 변경 add-breakers-purchase-auth-and-grpc-channel 결정 6~9).
// 구매 세션 쓰기 요청의 X-Purchase-Seq·X-Purchase-Mac을 인증 가드가 신원·역할과 멱등 키 형식을 본 뒤, 모양 검사보다 먼저 본다.
// 서버 ECDH 키와 구매 세션 저장소는 서비스(purchase-svc)의 포트가 맡는다. 이 모듈은 요청 인증 키(대칭 키)만 다룬다.
import { type KeyObject, createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { SetMetadata, createParamDecorator } from '@nestjs/common';
import { Counter, type Registry } from '@prometheus-io/client';
import type { FastifyRequest } from 'fastify';
import type { Principal } from './auth.js';
import { rawBodyOf } from './raw-body.js';

export const PURCHASE_SEQ_HEADER = 'x-purchase-seq';
export const PURCHASE_MAC_HEADER = 'x-purchase-mac';
/** HKDF info(판을 바꾸면 v2) */
export const PURCHASE_KEY_INFO = 'PEAKET-purchase-v1';
/** 요청 인증 키 길이(HMAC-SHA256 출력과 같다, 추천 적용 2026-11-01, 결정 9) */
export const PURCHASE_KEY_BYTES = 32;

/** 요청 인증 키 = HKDF-SHA256(ECDH 공유 비밀, salt = 입장 토큰 jti, info = PEAKET-purchase-v1), 32바이트 */
export function purchaseRequestKey(sharedSecret: Uint8Array, jti: string): Buffer {
  if (sharedSecret.length === 0) throw new RangeError('공유 비밀이 비었다');
  if (!jti) throw new RangeError('jti가 비었다');
  return Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.from(jti, 'utf8'), Buffer.from(PURCHASE_KEY_INFO, 'utf8'), PURCHASE_KEY_BYTES));
}

/** MAC 입력: METHOD LF 경로와 쿼리 LF 일련번호(10진수) LF base64url(SHA-256(본문 바이트)) */
export function purchaseMacInput(method: string, pathAndQuery: string, seq: number, body: Uint8Array): string {
  return `${method}\n${pathAndQuery}\n${seq}\n${createHash('sha256').update(body).digest('base64url')}`;
}

/** 채움 없는 base64url HMAC-SHA256 */
export function purchaseMac(key: Uint8Array | KeyObject, input: string): string {
  return createHmac('sha256', key).update(input, 'utf8').digest('base64url');
}

const SEQ = /^[1-9][0-9]{0,15}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

/** 머리 하나의 앞 0 없는 10진수 1 이상 2^53 − 1 이하. 아니면 undefined */
export function parsePurchaseSeq(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string' || !SEQ.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** 머리 하나의 채움 없는 base64url 43자(32바이트). 아니면 undefined */
export function parsePurchaseMac(value: string | string[] | undefined): Buffer | undefined {
  if (typeof value !== 'string' || !MAC.test(value)) return undefined;
  const b = Buffer.from(value, 'base64url');
  // 43자의 마지막 글자가 남는 비트를 쓰면 다시 인코딩한 값이 달라진다(같은 MAC의 다른 표기를 받지 않는다)
  return b.length === PURCHASE_KEY_BYTES && b.toString('base64url') === value ? b : undefined;
}

/** 구매 세션 하나: 서비스가 정한 참조와 요청 인증 키 */
export interface PurchaseSession {
  /** 일련번호를 올릴 때 다시 넘기는 참조(예: 구매 세션 ID). 처리기는 @CurrentPurchaseSession()으로 받는다 */
  ref: string;
  /** 이 요청의 구매 세션과 요청 인증 키(현재 키) */
  key: Uint8Array | KeyObject;
  /**
   * 키 교체 중에 함께 받는 옛 키들(BOT-100, BUILD_ORDER HOT-080). 있으면 key와 함께 모두 맞춰 보고 하나라도 맞으면 통과한다.
   * 없으면 key 하나만 본다(기존 조립·시험)
   */
  keys?: readonly (Uint8Array | KeyObject)[];
}

/** 서비스(purchase-svc)가 주는 포트(createService의 purchaseSessions) */
export interface PurchaseSessionPort {
  /** 이 요청의 구매 세션과 요청 인증 키. 없거나 끝났으면 undefined(401). 저장소 장애면 알맞은 Problem을 던진다 */
  resolve(request: FastifyRequest, principal: Principal): Promise<PurchaseSession | undefined>;
  /** seq가 그 구매 세션의 마지막 번호보다 클 때만 원자적으로 올리고 true. 아니면 false(다시 보낸 요청, 401) */
  advance(ref: string, seq: number): Promise<boolean>;
}

export const PURCHASE_SIGNED_METADATA = 'peaket:purchase-signed';

/** 처리기 장식자: 구매 세션 요청 서명을 확인한다(@Roles의 팬 역할과 함께, 공개 역할 처리기에는 달 수 없다) */
export function PurchaseSigned(): MethodDecorator {
  return SetMetadata(PURCHASE_SIGNED_METADATA, true);
}

const SESSION_REF = Symbol('peaket.purchaseSession');

/** 처리기 매개변수: 확인을 마친 구매 세션 참조. @PurchaseSigned가 없는 처리기에서 쓰면 던진다 */
export const CurrentPurchaseSession = createParamDecorator((_data: unknown, ctx: import('@nestjs/common').ExecutionContext): string => {
  const ref = (ctx.switchToHttp().getRequest<FastifyRequest>() as unknown as Record<symbol, string | undefined>)[SESSION_REF];
  if (ref === undefined) throw new Error('@CurrentPurchaseSession()은 @PurchaseSigned()를 단 처리기에서만 쓴다');
  return ref;
});

export type PurchaseRejection = 'missing' | 'malformed' | 'no_session' | 'mismatch' | 'replay';

/**
 * 거절 이유별 401 Problem(openapi x-peaket-problem-types, BUILD_ORDER BAS-040). 화면은 type으로 다음 동작을 고른다(docs/frontend.md §4.1 '401'):
 * 머리 없음·형식·서명 불일치는 구매 세션 키로 서명을 맞출 수 없다는 뜻이고, 세션 없음은 예매 시간이 끝났다는 뜻이며, 번호 재사용은
 * 다른 탭과 일련번호가 엇갈렸다는 뜻이다. 어느 머리·칸이 틀렸는지는 싣지 않는다(서명 오라클을 만들지 않는다)
 */
export const PURCHASE_REJECTION_PROBLEMS: Readonly<Record<PurchaseRejection, { type: string; status: 401; title: string }>> = Object.freeze({
  missing: { type: 'purchase-signature-invalid', status: 401, title: '요청 서명을 확인하지 못했습니다' },
  malformed: { type: 'purchase-signature-invalid', status: 401, title: '요청 서명을 확인하지 못했습니다' },
  mismatch: { type: 'purchase-signature-invalid', status: 401, title: '요청 서명을 확인하지 못했습니다' },
  no_session: { type: 'purchase-session-ended', status: 401, title: '예매 시간이 끝났습니다' },
  replay: { type: 'purchase-seq-reused', status: 401, title: '이미 받은 요청 번호입니다' },
});

const metricsByRegistry = new WeakMap<Registry, Counter<'service' | 'reason'>>();
export function purchaseRejections(registry: Registry): Counter<'service' | 'reason'> {
  let c = metricsByRegistry.get(registry);
  if (!c) {
    c = new Counter({
      name: 'purchase_request_rejections_total',
      help: '구매 세션 요청 서명 확인에서 거절한 수(reason: missing·malformed·no_session·mismatch·replay)',
      labelNames: ['service', 'reason'],
      registers: [registry],
    });
    metricsByRegistry.set(registry, c);
  }
  return c;
}

/**
 * 인증 가드가 부른다. 맞으면 구매 세션 참조를 요청에 붙이고, 틀리면 거절 이유를 돌려준다(가드가 401로 바꾼다).
 * 순서: 머리 형식 → 구매 세션 → 서명(상수 시간) → 일련번호. 서명이 틀리면 일련번호를 올리지 않는다(남이 번호를 태우지 못하게)
 */
export async function verifyPurchaseRequest(request: FastifyRequest, principal: Principal, port: PurchaseSessionPort): Promise<PurchaseRejection | undefined> {
  const rawSeq = request.headers[PURCHASE_SEQ_HEADER];
  const rawMac = request.headers[PURCHASE_MAC_HEADER];
  if (rawSeq === undefined && rawMac === undefined) return 'missing';
  const seq = parsePurchaseSeq(rawSeq);
  const mac = parsePurchaseMac(rawMac);
  if (seq === undefined || mac === undefined) return 'malformed';
  const session = await port.resolve(request, principal);
  if (!session) return 'no_session';
  const target = request.raw.url ?? request.url;
  const input = purchaseMacInput(request.method, target, seq, rawBodyOf(request));
  // 키 교체 중에는 현재 키와 옛 키를 모두 본다(하나라도 맞으면 통과). 어느 키가 맞았는지는 응답에 싣지 않는다
  const keys = session.keys && session.keys.length > 0 ? session.keys : [session.key];
  let matched = false;
  for (const key of keys) {
    const expected = Buffer.from(purchaseMac(key, input), 'base64url');
    if (expected.length === mac.length && timingSafeEqual(expected, mac)) matched = true;
  }
  if (!matched) return 'mismatch';
  if (!(await port.advance(session.ref, seq))) return 'replay';
  (request as unknown as Record<symbol, string>)[SESSION_REF] = session.ref;
  return undefined;
}
