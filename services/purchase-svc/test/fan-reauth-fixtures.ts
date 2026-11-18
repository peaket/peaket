// 팬 재인증 토큰 시험 도구(R-T39, docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인').
// identity가 주는 재인증 토큰과 같은 모양(ES256, r‖s 64바이트, typ reauth+jwt, aud fan)으로 서명하고,
// 팬 공개키 묶음(JWKS)을 주는 가짜 fetch와 명령을 적는 가짜 좌석 Redis(`reauth:jti:{jti}` SET NX PX, docs/data.md §3)를 둔다.
// 발급자는 시작 조립의 기본값(https://identity.peaket.example)과 다른 값으로 둔다(기본값을 잘못 쓰는 결함이 숨지 않게).
import { createHmac, generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';

export const ISS = 'https://identity.test';
export const DEFAULT_ISS = 'https://identity.peaket.example';
export const JWKS_URL = 'https://identity.test/internal/jwks/fan.json';

export interface FanKey {
  kid: string;
  priv: KeyObject;
  publicJwk: Record<string, string>;
}

export function fanKey(kid: string): FanKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kid, priv: privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, kid, alg: 'ES256', use: 'sig' } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export interface ReauthClaimsInput {
  nowMs: number;
  accountId: string;
  sessionId: string;
  act?: string;
  /** 토큰 수명(초). 5분 상수와 다르게 고른다 */
  lifeS?: number;
  jti?: string;
}

/** 정상 클레임. over로 칸을 바꾸거나(undefined면 뺀다) 더한다 */
export function reauthClaims(c: ReauthClaimsInput, over: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(c.nowMs / 1000);
  const base: Record<string, unknown> = {
    iss: ISS,
    sub: c.accountId,
    aud: 'fan',
    iat,
    exp: iat + (c.lifeS ?? 180),
    sid: c.sessionId,
    jti: c.jti ?? randomUUID(),
    act: c.act ?? 'FAN_SENSITIVE',
    provider: 'kakao',
    ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v === undefined) delete base[k];
  return base;
}

/** 서명한 재인증 토큰. header로 머리 칸을 바꾸고, signWith로 서명 키를 바꾼다(머리 kid는 key의 것 그대로) */
export function signReauth(key: FanKey, claims: Record<string, unknown>, o: { header?: Record<string, unknown>; signWith?: KeyObject } = {}): string {
  const head = b64({ alg: 'ES256', typ: 'reauth+jwt', kid: key.kid, ...o.header });
  const body = b64(claims);
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: o.signWith ?? key.priv, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

/** 서명 없는 토큰(alg none, BAT-415-reauth 리뷰 RV-09 (다)) */
export function unsignedReauth(kid: string, claims: Record<string, unknown>): string {
  return `${b64({ alg: 'none', typ: 'reauth+jwt', kid })}.${b64(claims)}.`;
}

/** 대칭 키 서명 토큰(alg HS256). 비밀로 공개키 좌표를 쓰는 고전 공격 모양(BAT-415-reauth 리뷰 RV-09 (다)) */
export function hs256Reauth(key: FanKey, claims: Record<string, unknown>): string {
  const head = b64({ alg: 'HS256', typ: 'reauth+jwt', kid: key.kid });
  const body = b64(claims);
  const mac = createHmac('sha256', Buffer.from(key.publicJwk.x!, 'base64url')).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${mac}`;
}

/**
 * up은 정상, throw는 연결 오류, http500은 서버 오류, hang은 답하지 않는다(받은 AbortSignal이 끊을 때까지 기다린다,
 * BAT-415-reauth 리뷰 RV-09 (가)·검증 V8). hang에서 신호가 없으면 영영 끝나지 않으므로 부르는 쪽이 시간 상한을 걸어야 한다
 */
export type FetchMode = 'up' | 'throw' | 'http500' | 'hang';

/** 팬 공개키 묶음을 주는 가짜 fetch. mode로 끊고, 받은 주소를 적는다 */
export function fakeJwksFetch(keys: readonly FanKey[]): { fetch: typeof fetch; urls: string[]; mode: FetchMode } {
  const state = {
    urls: [] as string[],
    mode: 'up' as FetchMode,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      state.urls.push(input instanceof Request ? input.url : String(input));
      if (state.mode === 'throw') throw new TypeError('fetch failed');
      if (state.mode === 'http500') return new Response('oops', { status: 500, headers: { 'content-type': 'text/plain' } });
      if (state.mode === 'hang') {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          if (!signal) return;
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return new Response(JSON.stringify({ keys: keys.map((k) => k.publicJwk) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  };
  return state;
}

export type RedisMode = 'real' | 'throw' | 'exists';

/**
 * 명령을 적는 가짜 좌석 Redis(`RedisReauthJtiStore`에 넘긴다). real은 NX를 흉내 낸다(이미 있으면 null),
 * throw는 연결 오류, exists는 처음 보는 키도 이미 있다고 답한다(세 상태의 가운데 대조용)
 */
export function fakeSeatRedis(): { command(args: readonly string[], o: { key: string }): Promise<unknown>; commands: string[][]; mode: RedisMode; keys: Set<string> } {
  const state = {
    commands: [] as string[][],
    mode: 'real' as RedisMode,
    keys: new Set<string>(),
    async command(args: readonly string[]) {
      state.commands.push([...args]);
      if (state.mode === 'throw') throw new Error('ECONNRESET');
      if (state.mode === 'exists') return null;
      const key = args[1]!;
      if (state.keys.has(key)) return null;
      state.keys.add(key);
      return 'OK';
    },
  };
  return state;
}
