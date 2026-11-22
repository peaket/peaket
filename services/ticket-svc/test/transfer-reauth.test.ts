// 양도·돌려주기 재인증 토큰 확인기 시험(BUILD_ORDER GAT-055, docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인',
// docs/security/authz-matrix.md §6 '받는 쪽 작업 op', docs/features/identity.md §7.1).
// 서명(9.1.1)·exp(9.2.1)·typ/iss(9.2.2)·aud(9.2.3)·sid/act/op·sub·남은 수명·jti 한 번 쓰기를 본다.
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { fakeClock, MemoryReauthJtiStore } from '@peaket/platform';
import { describe, expect, it } from 'vitest';
import { JwksFanReauthGate, ReauthUnavailable } from '../src/modules/ticket/adapters/jwks-fan-reauth-gate.js';
import type { TransferAct, TransferOp } from '../src/modules/ticket/application/transfers.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const NOW_S = NOW / 1000;
const ISS = 'https://identity.test';
const JWKS_URL = 'https://identity.test/internal/jwks/fan.json';
const ACCOUNT = '0193f2c0-0000-7000-8000-0000000000a1';
const SESSION = '0193f2c0-0000-7000-8000-0000000000b1';

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
const jwks = { keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y!, kid: 'fan-k1', alg: 'ES256', use: 'sig' }] };

function token(over: Record<string, unknown> = {}, o: { key?: KeyObject; header?: Record<string, unknown>; signWith?: KeyObject } = {}): string {
  const claims: Record<string, unknown> = {
    iss: ISS,
    sub: ACCOUNT,
    aud: 'fan',
    iat: Math.floor(NOW_S),
    exp: Math.floor(NOW_S) + 180,
    sid: SESSION,
    jti: randomUUID(),
    act: 'FAN_HIGH_RISK',
    op: 'TRANSFER_REQUEST',
    ...over,
  };
  for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
  const head = b64({ alg: 'ES256', typ: 'reauth+jwt', kid: 'fan-k1', ...o.header });
  const body = b64(claims);
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: o.signWith ?? o.key ?? privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

function gateAt(o: { nowMs?: number; fetch?: typeof fetch } = {}) {
  const clock = fakeClock({ now: o.nowMs ?? NOW });
  const jti = new MemoryReauthJtiStore();
  const gate = new JwksFanReauthGate({
    jwksUrl: JWKS_URL,
    issuer: ISS,
    jti,
    clock,
    fetch: o.fetch ?? (async () => new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } })),
  });
  return { gate, jti, clock };
}

const q = (act: TransferAct = 'FAN_HIGH_RISK', op: TransferOp = act === 'FAN_HIGH_RISK' ? 'TRANSFER_REQUEST' : 'TICKET_RETURN') => ({ accountId: ACCOUNT, sessionId: SESSION, act, op });

describe('양도·돌려주기 재인증 확인기', () => {
  it('[ASVS v5.0.0-9.1.1] 서명을 확인한 뒤에만 통과하고, 서명이 틀리면 거절한다', async () => {
    const { gate } = gateAt();
    expect(await gate.verify(token(), q())).toBe(true);
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(await gate.verify(token({}, { signWith: other.privateKey }), q())).toBe(false);
    // 다른 계정 키로 서명해도 공개키 묶음의 키가 아니면 거절한다
    expect(await gate.verify(token({}, { key: other.privateKey }), q())).toBe(false);
  });

  it('[ASVS v5.0.0-9.2.1] 만료된 토큰은 거절하고 jti를 잡지 않는다', async () => {
    const { gate, jti } = gateAt();
    const expired = token({ exp: Math.floor(NOW_S) - 1 });
    expect(await gate.verify(expired, q())).toBe(false);
    expect(await jti.claim(randomUUID(), NOW + 60_000, NOW)).toBe(true);
  });

  it('[ASVS v5.0.0-9.2.2] typ·iss가 다른 토큰은 거절한다', async () => {
    const { gate } = gateAt();
    expect(await gate.verify(token({}, { header: { typ: 'at+jwt' } }), q())).toBe(false);
    expect(await gate.verify(token({ iss: 'https://other.test' }), q())).toBe(false);
  });

  it('[ASVS v5.0.0-9.2.3] aud가 fan이 아니면 거절하고, 양도·돌려주기의 act·op만 받는다', async () => {
    const { gate } = gateAt();
    expect(await gate.verify(token({ aud: 'admin' }), q())).toBe(false);
    // 양도 요청은 FAN_HIGH_RISK·TRANSFER_REQUEST만 받는다
    expect(await gate.verify(token({ act: 'FAN_SENSITIVE', op: 'TRANSFER_REQUEST' }), q())).toBe(false);
    // 돌려주기는 FAN_SENSITIVE·TICKET_RETURN만 받는다
    expect(await gate.verify(token({ act: 'FAN_HIGH_RISK', op: 'TICKET_RETURN' }), q('FAN_SENSITIVE', 'TICKET_RETURN'))).toBe(false);
    expect(await gate.verify(token({ act: 'FAN_SENSITIVE', op: 'TICKET_RETURN' }), q('FAN_SENSITIVE', 'TICKET_RETURN'))).toBe(true);
  });

  it('세션·계정·남은 수명·jti 재사용을 본다', async () => {
    const { gate } = gateAt();
    expect(await gate.verify(token({ sid: '0193f2c0-0000-7000-8000-0000000000c1' }), q())).toBe(false);
    expect(await gate.verify(token({ sub: '0193f2c0-0000-7000-8000-0000000000c2' }), q())).toBe(false);
    const long = token({ exp: Math.floor(NOW_S) + 400 });
    expect(await gate.verify(long, q())).toBe(false);
    const once = token();
    expect(await gate.verify(once, q())).toBe(true);
    expect(await gate.verify(once, q())).toBe(false);
  });

  it('공개키 묶음을 받지 못하면 확인하지 못한 것(503)으로 던지고, 뜻밖 오류는 덮지 않는다', async () => {
    const { gate } = gateAt({ fetch: async () => new Response('nope', { status: 503 }) });
    await expect(gate.verify(token(), q())).rejects.toBeInstanceOf(ReauthUnavailable);
    const broken = gateAt({
      fetch: async () =>
        new Response(JSON.stringify({ keys: [{ ...jwks.keys[0], x: undefined }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await expect(broken.gate.verify(token(), q())).rejects.toBeInstanceOf(ReauthUnavailable);
  });
});
