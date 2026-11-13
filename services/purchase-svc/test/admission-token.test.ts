// 입장 토큰 확인(docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', ADR-0183 결정 8, ADR-0050 결정 9, BUILD_ORDER PRF-136).
// 서명은 queue-svc가 쓰는 것과 같은 방식(Node 표준 암호 모듈, ES256, r‖s 64바이트)으로 시험에서 만든다.
import { type KeyObject, randomUUID, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { type AdmissionKeys, AdmissionTokenRejected, admissionListsOf, FIRST_USE_MS, IAT_SKEW_MS, parseAdmissionJwks, verifyAdmissionToken } from '../src/modules/inventory/index.js';
import { b64, claimsOf as claimsFor, ISS, JNY, newKey, signAdmission } from './admission-fixtures.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const JTI = randomUUID();

const K1 = newKey('k1');
const K2 = newKey('k2');
const keys: AdmissionKeys = new Map([
  ['k1', K1.pub],
  ['k2', K2.pub],
]);

const claimsOf = (over: Record<string, unknown> = {}): Record<string, unknown> => claimsFor({ nowMs: NOW, jti: JTI }, over);
/** 서명한 토큰. header·claims로 칸을 바꾸거나 빼고, signWith로 서명 키를 바꾼다 */
function token(o: { header?: Record<string, unknown>; claims?: Record<string, unknown>; signWith?: KeyObject } = {}): string {
  return signAdmission(K1, o.claims ?? claimsOf(), { ...(o.header ? { header: o.header } : {}), ...(o.signWith ? { signWith: o.signWith } : {}) });
}
const verify = (t: string, nowMs = NOW) => verifyAdmissionToken(t, { keys, issuer: ISS, nowMs });
const reasonOf = (t: string, nowMs = NOW): string | undefined => {
  try {
    verify(t, nowMs);
    return undefined;
  } catch (e) {
    if (e instanceof AdmissionTokenRejected) return e.reason;
    throw e;
  }
};

describe('입장 토큰 확인', () => {
  test('ADR0183_8 서명·typ·iss·aud·exp가 맞으면 클레임을 돌려준다 [ASVS v5.0.0-9.1.1] [ASVS v5.0.0-9.2.2] [ASVS v5.0.0-9.2.3]', () => {
    const c = verify(token());
    expect(c).toEqual({
      jti: JTI,
      accountId: 'acct-1',
      loginSessionId: 'login-1',
      eventId: 'ev-1',
      journeyId: JNY,
      issuedAtMs: Math.floor(NOW / 1000) * 1000,
      expiresAtMs: (Math.floor(NOW / 1000) + 45 * 60) * 1000,
    });
  });

  test('ADR0183_8_우선구매 prio 클레임이 있으면 priorityGrantId로 돌려준다', () => {
    expect(verify(token({ claims: claimsOf({ prio: 'grant-1' }) })).priorityGrantId).toBe('grant-1');
  });

  test('ADR0265_7 lst는 1~10개의 중복 없는 명단 키 배열만 받고, 없으면 칸을 빼며, 틀리면 claims로 거절한다 [ASVS v5.0.0-2.3.2]', () => {
    expect(verify(token({ claims: claimsOf({ lst: ['lumen-fanclub-2026'] }) })).lists).toEqual(['lumen-fanclub-2026']);
    expect(verify(token()).lists).toBeUndefined();
    for (const lst of [[], 'lumen-fanclub-2026', ['BAD'], ['lumen-fanclub-2026', 'lumen-fanclub-2026'], Array.from({ length: 11 }, (_, i) => `list-${i + 1}`)]) {
      expect(reasonOf(token({ claims: claimsOf({ lst }) })), JSON.stringify(lst)).toBe('claims');
    }
    expect(admissionListsOf(token({ claims: claimsOf({ lst: ['lumen-fanclub-2026'] }) }))).toEqual(['lumen-fanclub-2026']);
    expect(admissionListsOf(token())).toEqual([]);
    expect(admissionListsOf(token({ claims: claimsOf({ lst: ['BAD'] }) }))).toBeUndefined();
    expect(admissionListsOf(undefined)).toBeUndefined();
  });

  test('kid로 고른 공개키로만 확인한다: 다른 kid의 키로 서명하거나 모르는 kid·kid 없음은 거절한다 [ASVS v5.0.0-9.1.3]', () => {
    expect(reasonOf(token({ signWith: K2.priv }))).toBe('signature'); // kid k1인데 k2 개인키로 서명
    expect(verify(token({ header: { kid: 'k2' }, signWith: K2.priv })).jti).toBe(JTI);
    expect(reasonOf(token({ header: { kid: 'k9' } }))).toBe('kid');
    const noKid = (() => {
      const head = b64({ alg: 'ES256', typ: 'admission+jwt' });
      const body = b64(claimsOf());
      const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: K1.priv, dsaEncoding: 'ieee-p1363' });
      return `${head}.${body}.${sig.toString('base64url')}`;
    })();
    expect(reasonOf(noKid)).toBe('kid');
  });

  test('머리의 jku·x5u·jwk·x5c 같은 키 출처는 읽지 않는다: 공격자 키를 jwk로 실어도 설정한 키로만 확인해 서명 불일치다 [ASVS v5.0.0-9.1.3]', () => {
    const attacker = newKey('k1');
    const t = token({ header: { jwk: attacker.publicJwk, jku: 'https://evil.example/jwks.json', x5u: 'https://evil.example/c', x5c: ['AAAA'] }, signWith: attacker.priv });
    expect(reasonOf(t)).toBe('signature');
  });

  test('ES256만 허용한다: none·HS256·RS256·alg 없음은 서명이 맞아 보여도 alg 거절이다 [ASVS v5.0.0-9.1.2]', () => {
    for (const alg of ['none', 'HS256', 'RS256', 'ES384', 'es256', undefined]) {
      const head = b64(alg === undefined ? { typ: 'admission+jwt', kid: 'k1' } : { alg, typ: 'admission+jwt', kid: 'k1' });
      const body = b64(claimsOf());
      expect(reasonOf(`${head}.${body}.${Buffer.alloc(64, 1).toString('base64url')}`)).toBe('alg');
    }
    // 공개키 곡선 좌표를 HMAC 비밀로 써서 만든 HS256(키 혼동 공격)도 alg에서 막힌다
    const head = b64({ alg: 'HS256', typ: 'admission+jwt', kid: 'k1' });
    expect(reasonOf(`${head}.${b64(claimsOf())}.${Buffer.alloc(32, 7).toString('base64url')}`)).toBe('alg');
  });

  test('typ가 admission+jwt가 아니면(액세스 토큰 at+jwt 등) 서명이 맞아도 거절한다 [ASVS v5.0.0-9.2.2]', () => {
    for (const typ of ['at+jwt', 'JWT', 'reauth+jwt', 'admission+JWT']) expect(reasonOf(token({ header: { typ } }))).toBe('typ');
    expect(reasonOf(token({ header: { typ: undefined } }))).toBe('typ');
  });

  test('iss가 설정한 발급자와 다르거나 없으면 거절한다 [ASVS v5.0.0-9.2.2]', () => {
    expect(reasonOf(token({ claims: claimsOf({ iss: 'https://other.example' }) }))).toBe('iss');
    expect(reasonOf(token({ claims: claimsOf({ iss: undefined }) }))).toBe('iss');
  });

  test('aud가 purchase가 아니면 거절한다: 배열·다른 값·없음 [ASVS v5.0.0-9.2.3]', () => {
    for (const aud of ['fan', 'purchase ', ['purchase'], ['purchase', 'fan'], undefined]) expect(reasonOf(token({ claims: claimsOf({ aud }) }))).toBe('aud');
  });

  test('exp: 지금이 exp 이상이면 expired다(exp 정각도 거절). 바로 앞 1ms는 받는다 [ASVS v5.0.0-9.2.1]', () => {
    const exp = Math.floor(NOW / 1000) + 45 * 60;
    expect(reasonOf(token(), exp * 1000)).toBe('expired');
    expect(reasonOf(token(), exp * 1000 + 1)).toBe('expired');
    expect(reasonOf(token(), exp * 1000 - 1)).toBeUndefined();
  });

  test('iat가 지금보다 60초를 넘게 미래이면 not_yet이다(시계 오차 60초 안은 받는다) [ASVS v5.0.0-9.2.1]', () => {
    const iat = Math.floor(NOW / 1000);
    expect(IAT_SKEW_MS).toBe(60_000);
    expect(reasonOf(token({ claims: claimsOf({ iat: iat + 61, exp: iat + 3600 }) }))).toBe('not_yet');
    expect(reasonOf(token({ claims: claimsOf({ iat: iat + 60, exp: iat + 3600 }) }))).toBeUndefined();
  });

  test('exp와 iat가 정수 초가 아니거나 exp가 iat 이하이면 claims 거절이다 [ASVS v5.0.0-9.2.1]', () => {
    const iat = Math.floor(NOW / 1000);
    for (const over of [{ exp: undefined }, { exp: '9999999999' }, { exp: iat + 0.5 }, { iat: undefined }, { iat: '1' }, { exp: iat }, { exp: iat - 1 }, { iat: Number.NaN }]) {
      expect(reasonOf(token({ claims: claimsOf(over) }))).toBe('claims');
    }
  });

  test('ADR0183_8_클레임 모양: jti·sub·sid·event는 키 조각 모양, jny는 UUID, prio는 있으면 키 조각 모양이다. 서명이 맞아도 모양이 틀리면 거절한다', () => {
    const bad = [
      { jti: 'a:b' },
      { jti: 'a}b' },
      { jti: '' },
      { jti: 'x'.repeat(65) },
      { jti: 7 },
      { sub: 'a b' },
      { sub: undefined },
      { sid: '{x}' },
      { sid: undefined },
      { event: 'ev:1' },
      { event: undefined },
      { jny: 'not-a-uuid' },
      { jny: undefined },
      { prio: 'a:b' },
      { prio: 5 },
    ];
    for (const over of bad) expect(reasonOf(token({ claims: claimsOf(over) })), JSON.stringify(over)).toBe('claims');
    expect(reasonOf(token({ claims: claimsOf({ jny: JNY.toUpperCase() }) }))).toBeUndefined();
  });

  test('서명 한 바이트만 바꾸거나 본문을 바꾸면 signature 거절이고, 서명 길이가 64바이트가 아니면 format이다 [ASVS v5.0.0-9.1.1]', () => {
    const t = token();
    const [h, p, s] = t.split('.') as [string, string, string];
    const flipped = Buffer.from(s, 'base64url');
    flipped[10] = flipped[10]! ^ 1;
    expect(reasonOf(`${h}.${p}.${flipped.toString('base64url')}`)).toBe('signature');
    expect(reasonOf(`${h}.${b64(claimsOf({ event: 'ev-2' }))}.${s}`)).toBe('signature');
    expect(reasonOf(`${h}.${p}.${Buffer.alloc(63, 1).toString('base64url')}`)).toBe('format');
    expect(reasonOf(`${h}.${p}.${Buffer.alloc(65, 1).toString('base64url')}`)).toBe('format');
  });

  test('모양이 틀린 토큰은 format이다: 조각 수, 채움 문자, 허용 밖 글자, 비정규 base64url, JSON 아님, 길이 상한 [ASVS v5.0.0-9.1.1]', () => {
    const t = token();
    const [h, p, s] = t.split('.') as [string, string, string];
    for (const bad of ['', 'a', 'a.b', `${t}.x`, `${h}.${p}.`, `.${p}.${s}`, `${h}..${s}`, `${h}=.${p}.${s}`, `${h}+.${p}.${s}`, `${h} .${p}.${s}`, `${h}.${p}.${s}\n`]) {
      expect(reasonOf(bad), JSON.stringify(bad)).toBe('format');
    }
    // JSON이 아닌 머리·본문, 객체가 아닌 JSON
    const raw = (v: string) => Buffer.from(v).toString('base64url');
    expect(reasonOf(`${raw('not json')}.${p}.${s}`)).toBe('format');
    expect(reasonOf(`${raw('[]')}.${p}.${s}`)).toBe('format');
    expect(reasonOf(`${raw('null')}.${p}.${s}`)).toBe('format');
    // 서명이 맞는 본문이 JSON 객체가 아니어도 format이다
    for (const body of ['not json', '[]', '"x"', 'null', '7']) {
      const head = b64({ alg: 'ES256', typ: 'admission+jwt', kid: 'k1' });
      const sig = sign('sha256', Buffer.from(`${head}.${raw(body)}`), { key: K1.priv, dsaEncoding: 'ieee-p1363' });
      expect(reasonOf(`${head}.${raw(body)}.${sig.toString('base64url')}`), body).toBe('format');
    }
    expect(reasonOf(`${h}.${p}.${s}`.padEnd(2049, 'A'))).toBe('format');
    // 마지막 글자가 남는 비트를 쓰는 비정규 표기(같은 바이트의 다른 글)는 받지 않는다
    expect(reasonOf(`${h}.${p}.${s.slice(0, -1)}${s.endsWith('A') ? 'B' : 'A'}`)).not.toBeUndefined();
  });

  test('ADR0183_8_토큰이 문자열이 아니면(헤더 중복 배열·없음) format이다', () => {
    expect(() => verifyAdmissionToken(undefined as unknown as string, { keys, issuer: ISS, nowMs: NOW })).toThrow(AdmissionTokenRejected);
    expect(() => verifyAdmissionToken(['a.b.c'] as unknown as string, { keys, issuer: ISS, nowMs: NOW })).toThrow(AdmissionTokenRejected);
  });

  test('ADR0183_8_첫 사용 기한은 iat + 5분이다(상수)', () => {
    expect(FIRST_USE_MS).toBe(5 * 60_000);
  });
});

describe('공개키 묶음 읽기 (PEAKET_ADMISSION_JWKS)', () => {
  const jwks = (keysArr: unknown[]) => JSON.stringify({ keys: keysArr });

  test('공개 P-256 키를 kid로 담는다: use sig·alg ES256 표시는 받는다 [ASVS v5.0.0-9.1.3]', () => {
    const m = parseAdmissionJwks(jwks([{ ...K1.publicJwk, use: 'sig', alg: 'ES256' }, K2.publicJwk]));
    expect([...m.keys()].sort()).toEqual(['k1', 'k2']);
    // 읽은 키로 실제 확인이 된다
    expect(verifyAdmissionToken(token(), { keys: m, issuer: ISS, nowMs: NOW }).jti).toBe(JTI);
  });

  test('개인 성분(d)이 섞이면 시작하지 않는다. 오류 문구에 키 값을 싣지 않는다 [ASVS v5.0.0-9.1.3]', () => {
    const priv = (K1.priv.export({ format: 'jwk' }) as Record<string, string>).d!;
    let msg = '';
    try {
      parseAdmissionJwks(jwks([{ ...K1.publicJwk, d: priv }]));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/개인/);
    expect(msg).not.toContain(priv);
  });

  test('[ASVS v5.0.0-9.1.3]_모양이 틀리면 던진다: JSON 아님, keys 없음·빔, EC가 아님, P-256이 아님, kid 없음·모양 틀림·중복, 곡선 위의 점이 아님, use·alg가 맞지 않음', () => {
    const k = K1.publicJwk;
    const bad: Array<[string, string]> = [
      ['json', 'nope'],
      ['no keys', JSON.stringify({})],
      ['empty', jwks([])],
      ['keys not array', JSON.stringify({ keys: {} })],
      ['not EC', jwks([{ ...k, kty: 'RSA' }])],
      ['not P-256', jwks([{ ...k, crv: 'P-384' }])],
      ['no kid', jwks([{ kty: 'EC', crv: 'P-256', x: k.x, y: k.y }])],
      ['kid shape', jwks([{ ...k, kid: 'a b' }])],
      ['dup kid', jwks([k, k])],
      ['off curve', jwks([{ ...k, y: Buffer.alloc(32, 1).toString('base64url') }])],
      ['use enc', jwks([{ ...k, use: 'enc' }])],
      ['alg RS256', jwks([{ ...k, alg: 'RS256' }])],
      ['x missing', jwks([{ kty: 'EC', crv: 'P-256', kid: 'k1', y: k.y }])],
    ];
    for (const [name, raw] of bad) expect(() => parseAdmissionJwks(raw), name).toThrow();
  });

  test('[ASVS v5.0.0-9.1.3]_담긴 키는 공개키 객체다(서명에 쓸 수 없다)', () => {
    const m = parseAdmissionJwks(jwks([K1.publicJwk]));
    expect(m.get('k1')!.type).toBe('public');
  });
});
