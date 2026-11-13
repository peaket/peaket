// 구매 세션 소지 증명의 탈취 재현과 키 교체(BUILD_ORDER BOT-100, ADR-0124, docs/features/seat-hold.md §2 '요청 인증 키').
// 서버 ECDH 키를 모르는 공격자는 입장 토큰의 jti를 알아도 X-Purchase-Mac을 맞출 수 없다. 키 교체 중에는 옛 키로 서명한 요청도 받는다.
import 'reflect-metadata';
import { createECDH, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { describe, expect, test } from 'vitest';
import {
  type Principal,
  purchaseMac,
  purchaseMacInput,
  purchaseRequestKey,
  type PurchaseSession,
  type PurchaseSessionPort,
  verifyPurchaseRequest,
} from '@peaket/platform';
import { PURCHASE_ECDH_KEY_ENV, PURCHASE_ECDH_KEY_PREV_ENV, ServerEcdhKey } from '../src/modules/inventory/index.js';

const JTI = 'ps-theft';
const PATH = '/v1/events/ev-1/holds';
const PRINCIPAL: Principal = { accountId: 'acct-1', sessionId: 'ls-1', aud: 'fan', scopes: ['ticket:buy'] };

/** P-256 키 쌍 하나(서버·클라이언트·공격자) */
function keyPair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh;
}

/** createECDH의 공개키(비압축 점)를 KeyObject로 바꾼다 */
function publicKeyOf(ecdh: ReturnType<typeof keyPair>): KeyObject {
  const pub = ecdh.getPublicKey();
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    format: 'jwk',
  });
}

/** 서버 공개키와 클라이언트 개인키로 요청 인증 키를 만든다 */
function requestKey(server: ReturnType<typeof keyPair>, client: ReturnType<typeof keyPair>): Buffer {
  return purchaseRequestKey(client.computeSecret(server.getPublicKey()), JTI);
}

function macOf(key: Buffer, seq: number): string {
  return purchaseMac(key, purchaseMacInput('POST', PATH, seq, Buffer.alloc(0)));
}

/** 머리만 있는 최소 요청(rawBody가 없으면 빈 본문이다) */
function request(seq: number, mac: string): FastifyRequest {
  return {
    method: 'POST',
    url: PATH,
    raw: { url: PATH },
    headers: { 'x-purchase-seq': String(seq), 'x-purchase-mac': mac },
  } as unknown as FastifyRequest;
}

/** 구매 세션 포트 대역: 현재 키와 옛 키를 함께 주고, 일련번호는 메모리로 지킨다 */
class FakePort implements PurchaseSessionPort {
  readonly advanced: Array<[string, number]> = [];
  readonly #last = new Map<string, number>();
  constructor(
    private readonly key: Buffer,
    private readonly keys?: Buffer[],
    private readonly present = true,
  ) {}
  async resolve(): Promise<PurchaseSession | undefined> {
    return this.present ? { ref: JTI, key: this.key, ...(this.keys ? { keys: this.keys } : {}) } : undefined;
  }
  async advance(ref: string, seq: number): Promise<boolean> {
    this.advanced.push([ref, seq]);
    if (seq <= (this.#last.get(ref) ?? 0)) return false;
    this.#last.set(ref, seq);
    return true;
  }
}

describe('BOT-100 구매 세션 탈취 재현 [S-T16 ②] [ASVS v5.0.0-2.2.1] [ASVS v5.0.0-2.2.2]', () => {
  const server = keyPair();
  const client = keyPair();
  const attacker = keyPair();
  const key = requestKey(server, client);
  const attackerKey = requestKey(server, attacker);

  test('정상 클라이언트의 서명은 통과하고 일련번호를 한 번 올린다', async () => {
    const port = new FakePort(key);
    expect(await verifyPurchaseRequest(request(1, macOf(key, 1)), PRINCIPAL, port)).toBeUndefined();
    expect(port.advanced).toEqual([[JTI, 1]]);
  });

  test('jti를 훔쳐도 요청 인증 키가 없으면 MAC 불일치이고 일련번호를 올리지 않는다', async () => {
    const port = new FakePort(key);
    expect(await verifyPurchaseRequest(request(2, macOf(attackerKey, 2)), PRINCIPAL, port)).toBe('mismatch');
    expect(port.advanced).toEqual([]);
  });

  test('같은 서명을 다시 보내면 일련번호 재사용으로 거절한다', async () => {
    const port = new FakePort(key);
    expect(await verifyPurchaseRequest(request(1, macOf(key, 1)), PRINCIPAL, port)).toBeUndefined();
    expect(await verifyPurchaseRequest(request(1, macOf(key, 1)), PRINCIPAL, port)).toBe('replay');
    expect(port.advanced).toEqual([
      [JTI, 1],
      [JTI, 1],
    ]);
  });

  test('머리 없음·모양 오류·세션 없음은 각각의 거절 이유다', async () => {
    const port = new FakePort(key);
    const none = { method: 'POST', url: PATH, raw: { url: PATH }, headers: {} } as unknown as FastifyRequest;
    expect(await verifyPurchaseRequest(none, PRINCIPAL, port)).toBe('missing');
    expect(await verifyPurchaseRequest(request(0, macOf(key, 0)), PRINCIPAL, port)).toBe('malformed');
    const absent = new FakePort(key, undefined, false);
    expect(await verifyPurchaseRequest(request(1, macOf(key, 1)), PRINCIPAL, absent)).toBe('no_session');
  });

  test('키 교체 중에는 옛 키로 서명한 요청도 통과한다(현재 키와 옛 키를 모두 본다)', async () => {
    const oldServer = keyPair();
    const oldKey = requestKey(oldServer, client);
    const port = new FakePort(key, [key, oldKey]);
    expect(await verifyPurchaseRequest(request(1, macOf(oldKey, 1)), PRINCIPAL, port)).toBeUndefined();
    expect(port.advanced).toEqual([[JTI, 1]]);
    // 공격자의 키는 여전히 거절된다
    expect(await verifyPurchaseRequest(request(2, macOf(attackerKey, 2)), PRINCIPAL, port)).toBe('mismatch');
  });
});

describe('BOT-100 서버 ECDH 키 교체', () => {
  function jwk(kid: string): string {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
    return JSON.stringify({ ...j, kid });
  }

  test('PEAKET_PURCHASE_ECDH_KEY_PREV가 있으면 옛 키의 공유 비밀도 함께 준다', () => {
    const current = jwk('ecdh-2');
    const previous = jwk('ecdh-1');
    const ring = ServerEcdhKey.fromEnv({ [PURCHASE_ECDH_KEY_ENV]: current, [PURCHASE_ECDH_KEY_PREV_ENV]: previous });
    expect(ring.kid).toBe('ecdh-2');
    expect(ring.previous?.kid).toBe('ecdh-1');
    const client = keyPair();
    const clientPublic = publicKeyOf(client);
    const secrets = ring.sharedSecrets(clientPublic);
    expect(secrets).toHaveLength(2);
    expect(secrets[0]).toEqual(ring.sharedSecret(clientPublic));
    expect(secrets[1]).toEqual(ring.previous!.sharedSecret(clientPublic));
  });

  test('옛 키의 kid가 현재 키와 같거나 옛 키 JWK가 틀리면 시작하지 않는다', () => {
    const current = jwk('ecdh-1');
    expect(() => ServerEcdhKey.fromEnv({ [PURCHASE_ECDH_KEY_ENV]: current, [PURCHASE_ECDH_KEY_PREV_ENV]: current })).toThrow(PURCHASE_ECDH_KEY_PREV_ENV);
    expect(() => ServerEcdhKey.fromEnv({ [PURCHASE_ECDH_KEY_ENV]: current, [PURCHASE_ECDH_KEY_PREV_ENV]: 'not json' })).toThrow(PURCHASE_ECDH_KEY_PREV_ENV);
  });
});
