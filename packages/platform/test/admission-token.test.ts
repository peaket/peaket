// platform 입장 토큰 확인 단위 시험(BUILD_ORDER HOT-090, BAT-052, ADR-0296 결정 2).
// 정본: docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현'(ES256, typ admission+jwt, iss 설정값, aud purchase, exp 정각부터 거절,
// iat는 지금 + 60초까지), ADR-0183 결정 8, §7 'realtime-gw의 첫 구현' '핸드셰이크' ④, §12 S-T42 ②. purchase-svc 시험과 같은 정본 값으로 본다.
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { AdmissionTokenRejected, parseAdmissionJwks, verifyAdmissionToken } from '../src/index.js';

const ISS = 'https://queue.peaket.example';
const JNY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
/** 초 단위가 아닌 지금(ms) */
const NOW = Date.parse('2026-11-18T05:00:00.000Z') + 437;
const IAT = Math.floor(NOW / 1000);
const EXP = IAT + 45 * 60;

const newKey = (kid: string) => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kid, priv: privateKey, jwk: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, kid } };
};
const K1 = newKey('k1');
const K2 = newKey('k2');
const keys = parseAdmissionJwks(JSON.stringify({ keys: [K1.jwk, K2.jwk] }));

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const claims = (over: Record<string, unknown> = {}) => ({ iss: ISS, sub: 'acct-1', aud: 'purchase', jti: 'jti-1', sid: 'login-1', event: 'ev-1', jny: JNY, iat: IAT, exp: EXP, ...over });
function token(o: { header?: Record<string, unknown>; claims?: Record<string, unknown>; signWith?: KeyObject } = {}): string {
  const head = b64({ alg: 'ES256', typ: 'admission+jwt', kid: 'k1', ...o.header });
  const body = b64(o.claims ?? claims());
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: o.signWith ?? K1.priv, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}
const reasonOf = (t: unknown, nowMs = NOW): string | undefined => {
  try {
    verifyAdmissionToken(t, { keys, issuer: ISS, nowMs });
    return undefined;
  } catch (e) {
    if (e instanceof AdmissionTokenRejected) return e.reason;
    throw e;
  }
};

describe('S-T42 ② 입장 토큰 확인(platform)', () => {
  test('S-T42 ② 맞는 토큰은 클레임을 돌려준다(sub → accountId, event → eventId, exp × 1000)', () => {
    expect(verifyAdmissionToken(token(), { keys, issuer: ISS, nowMs: NOW })).toEqual({
      jti: 'jti-1',
      accountId: 'acct-1',
      loginSessionId: 'login-1',
      eventId: 'ev-1',
      journeyId: JNY,
      issuedAtMs: IAT * 1000,
      expiresAtMs: EXP * 1000,
    });
  });

  test('S-T42 ② 서명 틀림: 다른 키로 서명, 서명 한 비트 바꿈, 본문 바꿈은 signature다', () => {
    expect(reasonOf(token({ signWith: K2.priv }))).toBe('signature');
    const [h, p, s] = token().split('.') as [string, string, string];
    const flipped = Buffer.from(s, 'base64url');
    flipped[5] = flipped[5]! ^ 1;
    expect(reasonOf(`${h}.${p}.${flipped.toString('base64url')}`)).toBe('signature');
    expect(reasonOf(`${h}.${b64(claims({ event: 'ev-2' }))}.${s}`)).toBe('signature');
    // 다른 kid의 키로 확인하면 맞다(kid로 키를 고른다)
    expect(reasonOf(token({ header: { kid: 'k2' }, signWith: K2.priv }))).toBeUndefined();
    expect(reasonOf(token({ header: { kid: 'k9' } }))).toBe('kid');
  });

  test('S-T42 ② ES256이 아닌 alg는 거절한다', () => {
    for (const alg of ['none', 'HS256', 'RS256', 'ES384']) expect(reasonOf(token({ header: { alg } })), alg).toBe('alg');
  });

  test('S-T42 ② typ가 admission+jwt가 아니면 서명이 맞아도 typ다', () => {
    for (const typ of ['at+jwt', 'JWT', 'admission+JWT', undefined]) expect(reasonOf(token({ header: { typ } })), String(typ)).toBe('typ');
  });

  test('S-T42 ② iss가 설정값과 다르거나 없으면 iss, aud가 purchase가 아니면(배열·다른 값·없음) aud다', () => {
    expect(reasonOf(token({ claims: claims({ iss: 'https://other.example' }) }))).toBe('iss');
    expect(reasonOf(token({ claims: claims({ iss: undefined }) }))).toBe('iss');
    for (const aud of ['fan', ['purchase'], undefined, 'purchase ']) expect(reasonOf(token({ claims: claims({ aud }) })), JSON.stringify(aud)).toBe('aud');
  });

  test('S-T42 ② exp: 정각(exp × 1000)부터 expired이고 1ms 앞은 받는다', () => {
    expect(reasonOf(token(), EXP * 1000 - 1)).toBeUndefined();
    expect(reasonOf(token(), EXP * 1000)).toBe('expired');
    expect(reasonOf(token(), EXP * 1000 + 1)).toBe('expired');
  });

  test('S-T42 ② iat: 지금 + 60,000ms까지는 받고 + 60,001ms는 not_yet이다', () => {
    // iat × 1000 = 지금 + 60,000 / + 60,001이 되게 지금을 고른다
    const iat = IAT + 1_000;
    const t = token({ claims: claims({ iat, exp: iat + 3_600 }) });
    expect(reasonOf(t, iat * 1000 - 60_000)).toBeUndefined();
    expect(reasonOf(t, iat * 1000 - 60_001)).toBe('not_yet');
  });

  test('S-T42 ② 클레임 모양(event·sub·jti·sid 키 조각, jny UUID, exp > iat)이 틀리면 claims다', () => {
    for (const over of [{ event: 'ev:1' }, { event: undefined }, { sub: 'a b' }, { jti: '' }, { sid: undefined }, { jny: 'x' }, { exp: IAT }, { exp: '9999999999' }]) {
      expect(reasonOf(token({ claims: claims(over) })), JSON.stringify(over)).toBe('claims');
    }
  });

  test('S-T42 ② 문자열이 아니거나 조각 수가 틀리거나 2,048자를 넘으면 format이다', () => {
    for (const t of [undefined, 7, ['a.b.c'], '', 'a.b', `${token()}.x`]) expect(reasonOf(t), JSON.stringify(t)).toBe('format');
    expect(reasonOf(token().padEnd(2_049, 'A'))).toBe('format');
  });

  test('S-T42 ② 공개키 묶음: 개인 성분 d가 섞이거나 P-256이 아니거나 kid가 없으면 던지고 글에 키 값을 싣지 않는다', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const priv = privateKey.export({ format: 'jwk' }) as Record<string, string>;
    const withD = { kty: 'EC', crv: 'P-256', x: priv.x!, y: priv.y!, d: priv.d!, kid: 'kd' };
    for (const k of [withD, { ...K1.jwk, crv: 'P-384' }, { ...K1.jwk, kid: undefined }]) {
      let msg = '';
      try {
        parseAdmissionJwks(JSON.stringify({ keys: [k] }));
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toBe('');
      expect(msg).not.toContain(priv.d!);
      expect(msg).not.toContain(K1.jwk.x);
    }
    expect(() => parseAdmissionJwks('not json')).toThrow();
    expect(() => parseAdmissionJwks(JSON.stringify({ keys: [] }))).toThrow();
  });
});
