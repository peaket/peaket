// 사전 검증 토큰·대기표의 HMAC 코덱(docs/features/queue-admission.md §3 '첫 구현의 세부', §10 '보안 토큰 및 키', ADR-0053 결정 13).
// 형식: v1.{kid}.{본문 base64url(JSON)}.{MAC base64url}, MAC = HMAC-SHA256(키[kid], 종류 문자열 ‖ "." ‖ "v1.{kid}.{본문}")
// - 형식 버전 v1이 알고리즘을 정한다(토큰 안의 알고리즘 표시를 쓰지 않는다, ASVS v5.0.0-9.1.2)
// - kid는 설정한 키 목록에서만 찾는다(9.1.3). MAC을 상수 시간으로 견준 뒤에만 본문을 읽는다(9.1.1)
// - 종류 문자열로 사전 검증 토큰과 대기표를 서로 바꿔 쓰지 못하게 한다(9.2.2)
// 키 설정: PEAKET_QUEUE_TOKEN_KEY = "{kid}:{base64 키}"(발급·검증), PEAKET_QUEUE_TOKEN_KEY_PREVIOUS(선택, 검증만). 키는 32바이트 이상
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { QueueTokens } from '../domain/ports.js';
import { type LobbyClaims, type PreverifyClaims, REASONS, type TicketClaims } from '../domain/queue.js';

export const QUEUE_TOKEN_KEY_ENV = 'PEAKET_QUEUE_TOKEN_KEY';
export const QUEUE_TOKEN_KEY_PREVIOUS_ENV = 'PEAKET_QUEUE_TOKEN_KEY_PREVIOUS';
const VERSION = 'v1';
const KIND = { preverify: 'PEAKET-preverify-v1', queue: 'PEAKET-queue-v1', lobby: 'PEAKET-lobby-v1' } as const;
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_KEY_BYTES = 32;

const id = z.string().min(1).max(64);
const ms = z.number().int().nonnegative();
const PreverifySchema = z
  .object({ e: id, a: id, d: z.string().max(128), i0: ms, iat: ms, exp: ms, jny: z.uuid(), vr: z.enum(REASONS).optional(), hd: z.literal(true).optional() })
  .strict();
const LobbySchema = z.object({ e: id, a: id, d: z.string().max(128), iat: ms, jny: z.uuid(), vr: z.enum(REASONS).optional(), hd: z.literal(true).optional() }).strict();
const TicketSchema = z
  .object({ e: id, a: id, d: z.string().max(128), s: z.number().int().positive(), g: z.number().int().positive(), seg: z.number().int().nonnegative(), rq: z.string().min(1).max(64), jny: z.uuid(), vr: z.enum(REASONS).optional() })
  .strict();

function parseKey(name: string, value: string): { kid: string; key: Buffer } {
  const at = value.indexOf(':');
  const kid = at > 0 ? value.slice(0, at) : '';
  if (!KID.test(kid)) throw new Error(`${name}의 kid가 틀렸다(영문·숫자·_- 1~32자 뒤에 ':'와 base64 키)`);
  const key = Buffer.from(value.slice(at + 1), 'base64');
  // 값은 오류 문구에 싣지 않는다
  if (key.length < MIN_KEY_BYTES) throw new Error(`${name}의 키는 ${MIN_KEY_BYTES}바이트 이상이어야 한다`);
  return { kid, key };
}

export class HmacQueueTokens implements QueueTokens {
  readonly #current: { kid: string; key: Buffer };
  readonly #keys = new Map<string, Buffer>();

  constructor(current: { kid: string; key: Buffer }, previous?: { kid: string; key: Buffer }) {
    this.#current = { kid: current.kid, key: Buffer.from(current.key) };
    this.#keys.set(current.kid, this.#current.key);
    if (previous && previous.kid !== current.kid) this.#keys.set(previous.kid, Buffer.from(previous.key));
  }

  static fromEnv(env: Record<string, string | undefined>): HmacQueueTokens {
    const cur = env[QUEUE_TOKEN_KEY_ENV];
    if (!cur) throw new Error(`${QUEUE_TOKEN_KEY_ENV}가 없다(대기표 서명 키, 비밀 관리에서 넣는다)`);
    const prev = env[QUEUE_TOKEN_KEY_PREVIOUS_ENV];
    return new HmacQueueTokens(parseKey(QUEUE_TOKEN_KEY_ENV, cur), prev ? parseKey(QUEUE_TOKEN_KEY_PREVIOUS_ENV, prev) : undefined);
  }

  preverify(c: PreverifyClaims): string {
    return this.#sign(KIND.preverify, c);
  }

  readPreverify(token: string): PreverifyClaims | null {
    return this.#read(KIND.preverify, token, PreverifySchema) as PreverifyClaims | null;
  }

  ticket(c: TicketClaims): string {
    return this.#sign(KIND.queue, c);
  }

  readTicket(token: string): TicketClaims | null {
    return this.#read(KIND.queue, token, TicketSchema) as TicketClaims | null;
  }

  lobby(c: LobbyClaims): string {
    return this.#sign(KIND.lobby, c);
  }

  readLobby(token: string): LobbyClaims | null {
    return this.#read(KIND.lobby, token, LobbySchema) as LobbyClaims | null;
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  #mac(kind: string, key: Buffer, signed: string): Buffer {
    return createHmac('sha256', key).update(`${kind}.${signed}`).digest();
  }

  #sign(kind: string, claims: object): string {
    const signed = `${VERSION}.${this.#current.kid}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${signed}.${this.#mac(kind, this.#current.key, signed).toString('base64url')}`;
  }

  #read(kind: string, token: string, schema: z.ZodType): unknown {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) return null;
    const [, kid, body, mac] = parts as [string, string, string, string];
    const key = this.#keys.get(kid);
    if (!key || !body || !mac) return null;
    const want = this.#mac(kind, key, `${VERSION}.${kid}.${body}`);
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    // 같은 바이트로 읽히는 다른 문자열(덧붙인 =, 끝 글자의 쓰지 않는 비트, +·/, 끼운 줄바꿈)은 받지 않는다. 대기표의 정체가 문자열 해시다
    if (got.toString('base64url') !== mac) return null;
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const r = schema.safeParse(json);
    return r.success ? r.data : null;
  }
}
