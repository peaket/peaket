// v0 입구의 팬 액세스 토큰 검증 시험(docs/infra.md §3 'v0 배포' 3, docs/features/identity.md §3,
// docs/security/asvs/v0-baseline.md 9.1.1·9.1.2·9.2.1·9.2.3).
// 시험 토큰은 node:crypto로 직접 서명한다(틀린 토큰을 마음대로 만들려고). 끝의 묶음은 tools/local/v0-token.mjs로 서명해 도구와 입구가 맞는지 본다.
import { createHmac, sign } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  ACCESS_COOKIE,
  JwksError,
  TOKEN_REJECTIONS,
  accessTokenFromCookie,
  createTokenVerifier,
  parseFanJwks,
  type FanJwks,
  type FanPublicJwk,
  type TokenRejection,
  type TokenResult,
} from '../src/gateway/token.js';
import { ISSUER, b64json, b64url, fanClaims, fanHeader, fanToken, makeFanKey, signJwt, signSegments } from './gateway-helpers.js';

/** 0x21~0x7E 보이는 ASCII 전부(공백 없음). sub·sid·pid가 받아야 하는 글자 전부다 */
const VISIBLE_ASCII = Array.from({ length: 0x7e - 0x21 + 1 }, (_v, i) => String.fromCharCode(0x21 + i)).join('');

// 밀리초가 0이 아닌 시각: 초로 '내려' 견주는지(반올림하면 경계 시험이 갈린다) 본다
const NOW_MS = Date.parse('2026-11-03T09:00:00.500Z');
const NOW_SEC = Math.floor(NOW_MS / 1000);

const keyA = makeFanKey('kid-a');
const keyB = makeFanKey('kid-b');
/** keyA와 kid가 같은 다른 키(서명만 틀린 토큰을 만든다) */
const impostor = makeFanKey('kid-a');

function verifier(jwks: FanJwks = { keys: [keyA.publicJwk, keyB.publicJwk] }, nowMs = NOW_MS): (token: string) => TokenResult {
  return createTokenVerifier({ jwks, issuer: ISSUER, clock: fakeClock({ now: nowMs }) });
}

function expectRejected(verify: (token: string) => TokenResult, token: string, reason: TokenRejection): void {
  expect(verify(token)).toEqual({ ok: false, reason });
}

function jwksJson(keys: unknown[]): string {
  return JSON.stringify({ keys });
}

describe('parseFanJwks: 공개키 목록 읽기', () => {
  test('BSL050_EC_P-256_공개키_목록을_읽는다 [ASVS v5.0.0-9.1.2]', () => {
    const { alg: _alg, use: _use, ...noAlg } = keyB.publicJwk;
    const parsed = parseFanJwks(jwksJson([keyA.publicJwk, noAlg]));
    expect(parsed.keys).toHaveLength(2);
    expect(parsed.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', x: keyA.publicJwk.x, y: keyA.publicJwk.y, kid: 'kid-a' });
    // alg는 고를 수 있는 칸이다(FanPublicJwk.alg?: 'ES256'). 없으면 ES256으로 본다
    expect(parsed.keys[1]).toMatchObject({ kty: 'EC', crv: 'P-256', x: keyB.publicJwk.x, y: keyB.publicJwk.y, kid: 'kid-b' });
    // 읽은 목록으로 검증기를 만들 수 있다
    expect(verifier(parsed)(fanToken(keyB, NOW_SEC)).ok).toBe(true);
  });

  test('BSL050_키가_없거나_JSON이_아니면_던진다', () => {
    // 키 자리에 객체가 아닌 값이 있어도 TypeError가 아니라 JwksError다
    for (const bad of ['', 'not json', '{}', '{"keys":[]}', '{"keys":{}}', '[]', 'null', '{"keys":[null]}', '{"keys":["kid-a"]}', '{"keys":[7]}']) {
      expect(() => parseFanJwks(bad), bad).toThrow(JwksError);
    }
  });

  test('BSL050_x·y가_없거나_P-256_곡선_위의_점이_아니면_던진다 [ASVS v5.0.0-9.1.2]', () => {
    const cases: Array<[string, unknown]> = [
      ['y 없음', { ...keyA.publicJwk, y: undefined }],
      ['x 숫자', { ...keyA.publicJwk, x: 7 }],
      ['x 빈 문자열', { ...keyA.publicJwk, x: '' }],
      // 두 키의 좌표를 섞은 점은 곡선 위에 있지 않다: 쓸 수 없는 키로 시작하지 않는다
      ['곡선 밖의 점', { ...keyA.publicJwk, y: keyB.publicJwk.y }],
    ];
    for (const [name, key] of cases) {
      expect(() => parseFanJwks(jwksJson([keyB.publicJwk, key])), name).toThrow(JwksError);
    }
  });

  test('BSL050_EC_P-256이_아니거나_alg가_ES256이_아닌_키는_던진다 [ASVS v5.0.0-9.1.2]', () => {
    const cases: Array<[string, unknown]> = [
      ['kty RSA', { ...keyA.publicJwk, kty: 'RSA' }],
      ['kty oct(대칭키)', { kty: 'oct', k: b64url('secret'), kid: 'kid-a' }],
      ['crv P-384', { ...keyA.publicJwk, crv: 'P-384' }],
      ['x 없음', { ...keyA.publicJwk, x: undefined }],
      ['alg RS256', { ...keyA.publicJwk, alg: 'RS256' }],
      ['alg HS256', { ...keyA.publicJwk, alg: 'HS256' }],
      ['alg none', { ...keyA.publicJwk, alg: 'none' }],
    ];
    for (const [name, key] of cases) {
      expect(() => parseFanJwks(jwksJson([keyB.publicJwk, key])), name).toThrow(JwksError);
    }
  });

  test('BSL050_kid가_없거나_비었거나_겹치면_던진다', () => {
    const cases: Array<[string, unknown[]]> = [
      ['kid 없음', [{ ...keyA.publicJwk, kid: undefined }]],
      ['kid 빈 문자열', [{ ...keyA.publicJwk, kid: '' }]],
      ['kid 숫자', [{ ...keyA.publicJwk, kid: 7 }]],
      ['kid 겹침', [keyA.publicJwk, { ...keyB.publicJwk, kid: 'kid-a' }]],
    ];
    for (const [name, keys] of cases) {
      expect(() => parseFanJwks(jwksJson(keys)), name).toThrow(JwksError);
    }
  });

  test('BSL050_개인키_칸_d가_든_키가_하나라도_있으면_던진다(서명_개인키는_클러스터에_두지_않는다)', () => {
    expect(() => parseFanJwks(jwksJson([keyA.privateJwk]))).toThrow(JwksError);
    expect(() => parseFanJwks(jwksJson([keyB.publicJwk, keyA.privateJwk]))).toThrow(JwksError);
  });
});

describe('accessTokenFromCookie: Cookie 머리에서 액세스 토큰', () => {
  test('BSL050_여러_쿠키_가운데_액세스_쿠키_값을_고른다', () => {
    expect(ACCESS_COOKIE).toBe('__Secure-peaket_at');
    expect(accessTokenFromCookie('theme=dark; __Secure-peaket_at=TOKEN1; lang=ko')).toBe('TOKEN1');
    expect(accessTokenFromCookie('__Secure-peaket_at=TOKEN2')).toBe('TOKEN2');
    expect(accessTokenFromCookie('a=1;__Secure-peaket_at=TOKEN3')).toBe('TOKEN3');
    // JWT 글자(점·밑줄·빼기)는 그대로 둔다
    expect(accessTokenFromCookie('__Secure-peaket_at=aa.bb_-.cc')).toBe('aa.bb_-.cc');
  });

  test('BSL050_같은_이름이_여럿이면_첫_값이다', () => {
    expect(accessTokenFromCookie('__Secure-peaket_at=first; __Secure-peaket_at=second')).toBe('first');
  });

  test('BSL050_없거나_비었거나_이름이_정확히_같지_않으면_undefined다', () => {
    expect(accessTokenFromCookie(undefined)).toBeUndefined();
    expect(accessTokenFromCookie('')).toBeUndefined();
    expect(accessTokenFromCookie('theme=dark')).toBeUndefined();
    expect(accessTokenFromCookie('__Secure-peaket_at=')).toBeUndefined();
    expect(accessTokenFromCookie('__Secure-peaket_at=; theme=dark')).toBeUndefined();
    expect(accessTokenFromCookie('x__Secure-peaket_at=bad; __Secure-peaket_at_old=bad2')).toBeUndefined();
    expect(accessTokenFromCookie('__Secure-peaket_partner_at=partner')).toBeUndefined();
    // 쿠키 이름은 대소문자를 가린다(RFC 6265). 접두사 __Secure-의 보장은 그 글자 그대로일 때만 선다
    expect(accessTokenFromCookie('__secure-peaket_at=lower; __SECURE-PEAKET_AT=upper')).toBeUndefined();
  });

  test('BSL050_배열_머리면_이어서_찾는다', () => {
    expect(accessTokenFromCookie(['theme=dark', '__Secure-peaket_at=ARR'])).toBe('ARR');
    expect(accessTokenFromCookie(['__Secure-peaket_at=one', '__Secure-peaket_at=two'])).toBe('one');
    expect(accessTokenFromCookie([])).toBeUndefined();
  });
});

describe('createTokenVerifier: 받는 토큰', () => {
  test('BSL050_맞는_토큰은_신원을_돌려준다 [ASVS v5.0.0-9.1.1]', () => {
    const verify = verifier();
    expect(verify(fanToken(keyA, NOW_SEC, { sub: 'acc-7', sid: 'sess-7', scope: 'ticket:buy offline', pid: 'pid-7' }))).toEqual({
      ok: true,
      identity: { sub: 'acc-7', sid: 'sess-7', scope: 'ticket:buy offline', pid: 'pid-7' },
    });
    // 목록의 둘째 키(kid-b)로 서명한 토큰도 받는다
    const second = verify(fanToken(keyB, NOW_SEC, { sub: 'acc-8', sid: 'sess-8' }));
    expect(second).toEqual({ ok: true, identity: { sub: 'acc-8', sid: 'sess-8', scope: 'ticket:buy' } });
  });

  test('BSL050_scope가_없으면_빈_문자열이고_pid가_없으면_신원에도_없다', () => {
    const result = verifier()(fanToken(keyA, NOW_SEC, { scope: undefined }));
    expect(result).toEqual({ ok: true, identity: { sub: 'u-1', sid: 's-1', scope: '' } });
    expect(result.ok && result.identity.pid).toBeUndefined();
  });

  test('BSL050_aud가_fan만_든_배열이어도_받는다 [ASVS v5.0.0-9.2.3]', () => {
    expect(verifier()(fanToken(keyA, NOW_SEC, { aud: ['fan'] }))).toEqual({ ok: true, identity: { sub: 'u-1', sid: 's-1', scope: 'ticket:buy' } });
  });

  test('BSL050_sub와_sid는_1024자까지_받는다', () => {
    const long = 'a'.repeat(1024);
    expect(verifier()(fanToken(keyA, NOW_SEC, { sub: long, sid: long }))).toEqual({ ok: true, identity: { sub: long, sid: long, scope: 'ticket:buy' } });
    expect(verifier()(fanToken(keyA, NOW_SEC, { sub: 'x', sid: 'y' }))).toEqual({ ok: true, identity: { sub: 'x', sid: 'y', scope: 'ticket:buy' } });
  });

  test('BSL050_scope와_pid도_1024자까지_받는다', () => {
    const long = 'b'.repeat(1024);
    expect(verifier()(fanToken(keyA, NOW_SEC, { scope: long, pid: long }))).toEqual({ ok: true, identity: { sub: 'u-1', sid: 's-1', scope: long, pid: long } });
  });

  test('BSL050_보이는_ASCII는_모두_받는다(sub·sid·pid는_공백없이_scope는_공백까지) [ASVS v5.0.0-4.1.3]', () => {
    // 너무 좁게(영숫자만) 거르는 구현도 틀렸다: 0x21~0x7E는 모두 받는다
    expect(verifier()(fanToken(keyA, NOW_SEC, { sub: VISIBLE_ASCII, sid: VISIBLE_ASCII, pid: VISIBLE_ASCII, scope: `${VISIBLE_ASCII} ${VISIBLE_ASCII}` }))).toEqual({
      ok: true,
      identity: { sub: VISIBLE_ASCII, sid: VISIBLE_ASCII, pid: VISIBLE_ASCII, scope: `${VISIBLE_ASCII} ${VISIBLE_ASCII}` },
    });
    expect(verifier()(fanToken(keyA, NOW_SEC, { sub: '!', sid: '~', pid: '"' })).ok).toBe(true);
  });
});

describe('createTokenVerifier: 모양(malformed)', () => {
  test('BSL050_세_조각이_아니면_malformed다', () => {
    const verify = verifier();
    const good = fanToken(keyA, NOW_SEC);
    for (const bad of ['', 'abc', 'a.b', `${good}.extra`, good.split('.').slice(0, 2).join('.')]) {
      expectRejected(verify, bad, 'malformed');
    }
  });

  test('BSL050_머리나_본문이_JSON이_아니면_malformed다', () => {
    const verify = verifier();
    // 머리가 JSON이 아니다
    expectRejected(verify, signSegments(keyA.privateKey, b64url('not json'), b64json(fanClaims(NOW_SEC))), 'malformed');
    // 본문이 JSON이 아니다(서명은 맞다)
    expectRejected(verify, signJwt(keyA.privateKey, fanHeader('kid-a'), 'not json'), 'malformed');
  });

  test('BSL050_base64url이_아닌_글자가_든_조각은_malformed다', () => {
    const verify = verifier();
    const headerSeg = b64json(fanHeader('kid-a'));
    const payloadSeg = b64json(fanClaims(NOW_SEC));
    // Node의 base64url 해독기는 모르는 글자를 건너뛰므로, 글자를 직접 보지 않으면 이 토큰을 맞는 토큰으로 읽는다(서명도 글자 그대로에 맞췄다)
    const star = `${headerSeg.slice(0, 3)}*${headerSeg.slice(3)}`;
    expectRejected(verify, signSegments(keyA.privateKey, star, payloadSeg), 'malformed');
    // base64(+, /)나 채움 글자(=)도 base64url이 아니다(RFC 7515 §2)
    const plus = `${headerSeg.slice(0, 3)}+${headerSeg.slice(3)}`;
    expectRejected(verify, signSegments(keyA.privateKey, plus, payloadSeg), 'malformed');
    expectRejected(verify, signSegments(keyA.privateKey, headerSeg, `${payloadSeg}=`), 'malformed');
  });

  test('BSL050_본문이나_서명_조각에_base64url이_아닌_글자가_있어도_malformed다', () => {
    const verify = verifier();
    const headerSeg = b64json(fanHeader('kid-a'));
    const payloadSeg = b64json(fanClaims(NOW_SEC));
    // 본문 조각: 서명은 글자 그대로(별표 포함)에 맞췄으므로, 머리만 엄격히 보고 본문을 너그럽게 읽는 구현은 이 토큰을 받는다
    const starPayload = `${payloadSeg.slice(0, 5)}*${payloadSeg.slice(5)}`;
    expectRejected(verify, signSegments(keyA.privateKey, headerSeg, starPayload), 'malformed');
    const spacePayload = `${payloadSeg.slice(0, 5)} ${payloadSeg.slice(5)}`;
    expectRejected(verify, signSegments(keyA.privateKey, headerSeg, spacePayload), 'malformed');
    // 서명 조각: 너그러운 해독기는 별표·마침표를 건너뛰고 맞는 64바이트를 얻는다
    const [h, p, s = ''] = fanToken(keyA, NOW_SEC).split('.');
    for (const badSig of [`${s.slice(0, 10)}*${s.slice(10)}`, `${s}=`, `${s.slice(0, 10)}+${s.slice(11)}`]) {
      expectRejected(verify, `${h}.${p}.${badSig}`, 'malformed');
    }
  });

  test('BSL050_JSON이지만_객체가_아닌_머리나_본문도_던지지_않고_거절한다', () => {
    const verify = verifier();
    const goodHeader = b64json(fanHeader('kid-a'));
    const goodPayload = b64json(fanClaims(NOW_SEC));
    for (const [headerSeg, payloadSeg] of [
      [b64url('null'), goodPayload],
      [b64url('[]'), goodPayload],
      [b64url('"ES256"'), goodPayload],
      [goodHeader, b64url('null')],
      [goodHeader, b64url('"text"')],
      [goodHeader, b64url('[1,2]')],
    ] as const) {
      const token = signSegments(keyA.privateKey, headerSeg, payloadSeg);
      let result: TokenResult | undefined;
      expect(() => (result = verify(token))).not.toThrow();
      expect(result?.ok).toBe(false);
    }
  });
});

describe('createTokenVerifier: 머리(alg·typ·kid)', () => {
  test('BSL050_alg가_ES256이_아니면_alg로_거절한다(none·HS256·RS256·없음) [ASVS v5.0.0-9.1.2]', () => {
    const verify = verifier();
    const payloadSeg = b64json(fanClaims(NOW_SEC));
    // ['ES256']: 느슨한 견줌(==)은 배열을 글자로 바꿔 같다고 본다
    for (const alg of ['none', 'HS256', 'RS256', 'ES384', 'es256', 'ES256 ', ['ES256'], undefined]) {
      // 서명 조각은 비우지 않고(모양은 맞게) ES256 서명을 그대로 둔다: alg만 틀렸다
      const token = signSegments(keyA.privateKey, b64json(fanHeader('kid-a', { alg })), payloadSeg);
      expectRejected(verify, token, 'alg');
    }
  });

  test('BSL050_alg_none에_빈_서명인_고전_공격도_받지_않는다 [ASVS v5.0.0-9.1.2]', () => {
    const token = `${b64json(fanHeader('kid-a', { alg: 'none' }))}.${b64json(fanClaims(NOW_SEC))}.`;
    const result = verifier()(token);
    expect(result.ok).toBe(false);
    // 빈 서명 조각을 모양 틀림으로 보든 alg로 보든 받지만, 서명 검증까지 가서 다른 까닭으로 떨어지면 안 된다
    expect(['alg', 'malformed']).toContain(result.ok ? 'ok' : result.reason);
  });

  test('BSL050_공개키를_HMAC_비밀로_쓴_HS256_토큰(키_혼동)은_alg로_거절한다 [ASVS v5.0.0-9.1.2]', () => {
    const headerSeg = b64json(fanHeader('kid-a', { alg: 'HS256' }));
    const payloadSeg = b64json(fanClaims(NOW_SEC));
    for (const secret of [JSON.stringify(keyA.publicJwk), keyA.publicJwk.x]) {
      const mac = createHmac('sha256', secret).update(`${headerSeg}.${payloadSeg}`).digest();
      expectRejected(verifier(), `${headerSeg}.${payloadSeg}.${b64url(mac)}`, 'alg');
    }
  });

  test('BSL050_typ이_at+jwt가_아니면_typ으로_거절한다 [ASVS v5.0.0-9.2.3]', () => {
    const verify = verifier();
    expectRejected(verify, fanToken(keyA, NOW_SEC, {}, { typ: undefined }), 'typ');
    expectRejected(verify, fanToken(keyA, NOW_SEC, {}, { typ: 'JWT' }), 'typ');
    expectRejected(verify, fanToken(keyA, NOW_SEC, {}, { typ: 'dpop+jwt' }), 'typ');
  });

  test('BSL050_typ은_at+jwt_글자_그대로만_받는다(대소문자·공백·배열은_typ) [ASVS v5.0.0-9.2.3]', () => {
    const verify = verifier();
    for (const typ of ['AT+JWT', 'At+Jwt', 'at+jwt ', ' at+jwt', 'at+jwt\u0000', ['at+jwt'], 7]) {
      expectRejected(verify, fanToken(keyA, NOW_SEC, {}, { typ }), 'typ');
    }
  });

  test('BSL050_kid가_없거나_목록에_없으면_kid로_거절한다 [ASVS v5.0.0-9.1.1]', () => {
    const verify = verifier();
    expectRejected(verify, fanToken(keyA, NOW_SEC, {}, { kid: undefined }), 'kid');
    expectRejected(verify, fanToken(keyA, NOW_SEC, {}, { kid: 'kid-unknown' }), 'kid');
    // 목록에 kid-a만 둔 검증기에 kid-b 토큰
    expectRejected(verifier({ keys: [keyA.publicJwk] }), fanToken(keyB, NOW_SEC), 'kid');
  });

  test('BSL050_kid가_글자가_아니거나_객체_속성_이름이면_던지지_않고_kid로_거절한다 [ASVS v5.0.0-9.1.1]', () => {
    const verify = verifier();
    // ['kid-a']: 객체 표나 느슨한 견줌으로 찾으면 'kid-a'로 바뀌어 찾아진다. 서명은 keyA로 맞게 했다
    for (const kid of [['kid-a'], { kid: 'kid-a' }, 7, '', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const token = fanToken(keyA, NOW_SEC, {}, { kid });
      let result: TokenResult | undefined;
      expect(() => (result = verify(token)), JSON.stringify(kid)).not.toThrow();
      expect(result, JSON.stringify(kid)).toEqual({ ok: false, reason: 'kid' });
    }
  });

  test('BSL050_머리에_실은_공개키(jwk)·키_주소(jku)는_믿지_않는다 [ASVS v5.0.0-9.1.1]', () => {
    const verify = verifier();
    // 공격자가 자기 키로 서명하고 그 공개키를 머리에 실었다: 목록의 kid-a 키로만 검증해야 한다
    const embedded = fanToken(impostor, NOW_SEC, {}, { jwk: impostor.publicJwk, jku: 'https://evil.example/jwks.json' });
    expectRejected(verify, embedded, 'signature');
    // 목록에 없는 kid에 공개키를 실어도 kid로 거절한다
    const attacker = makeFanKey('kid-attacker');
    expectRejected(verify, fanToken(attacker, NOW_SEC, {}, { jwk: attacker.publicJwk }), 'kid');
  });
});

describe('createTokenVerifier: 서명', () => {
  test('BSL050_서명한_뒤_본문을_고친_토큰은_signature로_거절한다 [ASVS v5.0.0-9.1.1]', () => {
    const [h, , s] = fanToken(keyA, NOW_SEC, { sub: 'victim' }).split('.');
    const forgedPayload = b64json(fanClaims(NOW_SEC, { sub: 'attacker' }));
    expectRejected(verifier(), `${h}.${forgedPayload}.${s}`, 'signature');
  });

  test('BSL050_kid가_같은_다른_키로_서명한_토큰은_signature로_거절한다 [ASVS v5.0.0-9.1.1]', () => {
    expectRejected(verifier(), fanToken(impostor, NOW_SEC), 'signature');
  });

  test('BSL050_다른_kid의_키로_서명한_토큰은_signature로_거절한다 [ASVS v5.0.0-9.1.1]', () => {
    // 머리는 kid-a인데 keyB로 서명했다
    const token = signJwt(keyB.privateKey, fanHeader('kid-a'), fanClaims(NOW_SEC));
    expectRejected(verifier(), token, 'signature');
  });

  test('BSL050_DER_서명이나_길이가_틀린_서명은_signature로_거절한다(JWS는_r||s_64바이트) [ASVS v5.0.0-9.1.1]', () => {
    const verify = verifier();
    expectRejected(verify, signJwt(keyA.privateKey, fanHeader('kid-a'), fanClaims(NOW_SEC), 'der'), 'signature');
    const headerSeg = b64json(fanHeader('kid-a'));
    const payloadSeg = b64json(fanClaims(NOW_SEC));
    const signature = sign('sha256', Buffer.from(`${headerSeg}.${payloadSeg}`), { key: keyA.privateKey, dsaEncoding: 'ieee-p1363' });
    expect(signature).toHaveLength(64);
    expectRejected(verify, `${headerSeg}.${payloadSeg}.${b64url(signature.subarray(0, 63))}`, 'signature');
    expectRejected(verify, `${headerSeg}.${payloadSeg}.${b64url(Buffer.concat([signature, Buffer.from([0])]))}`, 'signature');
    expectRejected(verify, `${headerSeg}.${payloadSeg}.${b64url(Buffer.alloc(64))}`, 'signature');
  });

  test('BSL050_서명이_틀리면_본문이_틀려도_signature다(서명을_먼저_본다) [ASVS v5.0.0-9.1.1]', () => {
    // 본문의 iss·aud·exp가 모두 틀렸어도, 서명이 틀린 토큰은 본문을 읽기 전에 signature로 거절한다
    const token = signJwt(impostor.privateKey, fanHeader('kid-a'), fanClaims(NOW_SEC, { iss: 'https://evil.example', aud: 'ops', exp: NOW_SEC - 10 }));
    expectRejected(verifier(), token, 'signature');
  });
});

describe('createTokenVerifier: 본문(iss·aud·exp·nbf·claims)', () => {
  test('BSL050_iss가_설정값이_아니면_issuer로_거절한다 [ASVS v5.0.0-9.2.3]', () => {
    const verify = verifier();
    expectRejected(verify, fanToken(keyA, NOW_SEC, { iss: 'https://evil.example' }), 'issuer');
    expectRejected(verify, fanToken(keyA, NOW_SEC, { iss: `${ISSUER}/` }), 'issuer');
    expectRejected(verify, fanToken(keyA, NOW_SEC, { iss: undefined }), 'issuer');
    // 배열·대소문자·공백: 느슨한 견줌이나 정규화 없이 글자 그대로 같아야 한다
    for (const iss of [[ISSUER], ISSUER.toUpperCase(), ` ${ISSUER}`, 7, null]) {
      expectRejected(verify, fanToken(keyA, NOW_SEC, { iss }), 'issuer');
    }
  });

  test('BSL050_aud가_fan이_아니면_audience로_거절한다 [ASVS v5.0.0-9.2.3]', () => {
    const verify = verifier();
    for (const aud of ['partner', 'ops', 'scanner', 'FAN', 'fan ', undefined, null, [], ['fan', 'partner'], ['partner', 'fan'], [['fan']], ['partner'], 7]) {
      expectRejected(verify, fanToken(keyA, NOW_SEC, { aud }), 'audience');
    }
  });

  test('BSL050_exp가_없거나_숫자가_아니거나_지금이거나_지났으면_expired다 [ASVS v5.0.0-9.2.1]', () => {
    const verify = verifier();
    expectRejected(verify, fanToken(keyA, NOW_SEC, { exp: undefined }), 'expired');
    expectRejected(verify, fanToken(keyA, NOW_SEC, { exp: String(NOW_SEC + 900) }), 'expired');
    expectRejected(verify, fanToken(keyA, NOW_SEC, { exp: NOW_SEC }), 'expired');
    expectRejected(verify, fanToken(keyA, NOW_SEC, { exp: NOW_SEC - 1 }), 'expired');
  });

  test('BSL050_exp가_지금보다_1초_뒤면_받는다(시계_허용오차_없음) [ASVS v5.0.0-9.2.1]', () => {
    expect(verifier()(fanToken(keyA, NOW_SEC, { exp: NOW_SEC + 1 })).ok).toBe(true);
  });

  test('BSL050_시계가_흐르면_같은_토큰이_만료된다(주입한_시계를_본다) [ASVS v5.0.0-9.2.1]', () => {
    const clock = fakeClock({ now: NOW_MS });
    const verify = createTokenVerifier({ jwks: { keys: [keyA.publicJwk] }, issuer: ISSUER, clock });
    const token = fanToken(keyA, NOW_SEC, { exp: NOW_SEC + 60 });
    expect(verify(token).ok).toBe(true);
    clock.advance(59_000); // NOW_SEC + 59.5초
    expect(verify(token).ok).toBe(true);
    clock.advance(500); // NOW_SEC + 60초 = exp
    expect(verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  test('BSL050_nbf가_지금보다_뒤면_not_yet_valid이고_지금이면_받는다 [ASVS v5.0.0-9.2.1]', () => {
    const verify = verifier();
    expectRejected(verify, fanToken(keyA, NOW_SEC, { nbf: NOW_SEC + 1 }), 'not_yet_valid');
    expectRejected(verify, fanToken(keyA, NOW_SEC, { nbf: NOW_SEC + 600 }), 'not_yet_valid');
    expect(verify(fanToken(keyA, NOW_SEC, { nbf: NOW_SEC })).ok).toBe(true);
    expect(verify(fanToken(keyA, NOW_SEC, { nbf: NOW_SEC - 30 })).ok).toBe(true);
  });

  test('BSL050_nbf가_있는데_숫자가_아니면_받지_않는다 [ASVS v5.0.0-9.2.1]', () => {
    // '있으면 지금이거나 그 앞일 때만 받는다'(docs/infra.md §3 'v0 배포' 3): 시각이 아닌 nbf는 그 조건을 채우지 못한다.
    // 숫자가 아닐 때 nbf를 건너뛰는 구현은 이 토큰을 받는다. 까닭은 not_yet_valid와 claims 가운데 하나로 둔다(계약이 정하지 않았다)
    const verify = verifier();
    for (const nbf of [String(NOW_SEC + 600), [NOW_SEC + 600], { at: NOW_SEC + 600 }, true]) {
      const result = verify(fanToken(keyA, NOW_SEC, { nbf }));
      expect(result.ok, JSON.stringify(nbf)).toBe(false);
      expect(['not_yet_valid', 'claims'], JSON.stringify(nbf)).toContain(result.ok ? 'ok' : result.reason);
    }
  });

  test('BSL050_sub·sid가_1~1024자_문자열이_아니면_claims다', () => {
    const verify = verifier();
    const tooLong = 'a'.repeat(1025);
    for (const name of ['sub', 'sid']) {
      for (const value of ['', tooLong, 42, null, ['u-1'], { id: 'u-1' }, undefined]) {
        expectRejected(verify, fanToken(keyA, NOW_SEC, { [name]: value }), 'claims');
      }
    }
  });

  test('BSL050_scope·pid의_형이_틀리면_claims다', () => {
    const verify = verifier();
    for (const scope of [42, ['ticket:buy'], null, 'c'.repeat(1025)]) {
      expectRejected(verify, fanToken(keyA, NOW_SEC, { scope }), 'claims');
    }
    for (const pid of [42, ['p-1'], null, 'p'.repeat(1025)]) {
      expectRejected(verify, fanToken(keyA, NOW_SEC, { pid }), 'claims');
    }
  });

  test('BSL050_sub·sid·pid에_공백·제어문자·ASCII_밖_글자가_있으면_claims다(머리_주입을_막는다) [ASVS v5.0.0-4.1.3]', () => {
    const verify = verifier();
    // 신원 값은 앱으로 가는 머리에 그대로 실린다. CR·LF는 머리를 하나 더 만들고, 탭·라틴1 글자(é)는 Node가 머리 값으로 그대로 보낸다
    const bad = [
      'u-1\r\nx-user-scope: ops:all',
      'u-1\nx-user-id: admin',
      'u-1\r',
      'u 1',
      ' u-1',
      'u-1 ',
      'u-1\t',
      'u-1\u0000',
      'u-1\u007f',
      'u-1 ',
      'usé',
      '관리자',
      'u-1 ',
    ];
    for (const name of ['sub', 'sid', 'pid']) {
      for (const value of bad) {
        expectRejected(verify, fanToken(keyA, NOW_SEC, { [name]: value }), 'claims');
      }
    }
  });

  test('BSL050_scope는_보이는_ASCII와_공백만_받고_제어문자·ASCII_밖_글자는_claims다(머리_주입을_막는다) [ASVS v5.0.0-4.1.3]', () => {
    const verify = verifier();
    expect(verify(fanToken(keyA, NOW_SEC, { scope: 'ticket:buy offline' })).ok).toBe(true);
    for (const scope of ['ticket:buy\r\nx-user-id: admin', 'ticket:buy\n', 'ticket:buy\tops:all', 'ticket:buy\u0000', 'ticket:buy\u007f', 'ticket:buyé', '티켓:구매', 'ticket:buy offline']) {
      expectRejected(verify, fanToken(keyA, NOW_SEC, { scope }), 'claims');
    }
  });
});

describe('TOKEN_REJECTIONS: 지표 까닭 이름', () => {
  test('BSL050_거절_까닭은_docs/infra.md_8의_열_가지_이름_그대로다', () => {
    // 모듈의 목록을 그대로 믿으면 이름이 틀려도 지표 시험이 통과하므로, 문서의 글자와 견준다
    expect([...TOKEN_REJECTIONS].sort()).toEqual(['alg', 'audience', 'claims', 'expired', 'issuer', 'kid', 'malformed', 'not_yet_valid', 'signature', 'typ']);
    expect(new Set(TOKEN_REJECTIONS).size).toBe(TOKEN_REJECTIONS.length);
  });
});

// ---- tools/local/v0-token.mjs와 맞추기 ----

interface V0PrivateJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
  kid: string;
}

/** tools/local/v0-token.mjs의 공개 함수(그 파일의 JSDoc 계약). 형 검사 범위를 이 패키지에 묶어 두려고 경로를 값으로 넘겨 읽는다 */
interface V0TokenTool {
  V0_TOKEN_ISSUER: string;
  V0_TOKEN_TTL_SECONDS: number;
  generateV0TokenKey(): { privateJwk: V0PrivateJwk; jwks: { keys: FanPublicJwk[] } };
  signV0Token(privateJwk: V0PrivateJwk, claims: { sub: string; sid: string; scope?: string; pid?: string; [k: string]: unknown }, options?: { nowMs?: number; header?: Record<string, unknown> }): string;
}

const TOOL_URL: string = new URL('../../../tools/local/v0-token.mjs', import.meta.url).href;

async function loadTool(): Promise<V0TokenTool> {
  return (await import(TOOL_URL)) as V0TokenTool;
}

describe('tools/local/v0-token.mjs와 입구가 맞다', () => {
  // 초가 딱 떨어지는 시각(도구가 exp를 어떻게 내리든 경계가 같게)
  const TOOL_NOW_MS = Date.parse('2026-11-03T09:00:00.000Z');

  test('BSL050_도구가_만든_공개키_목록과_토큰을_입구가_받는다 [ASVS v5.0.0-9.1.1] [ASVS v5.0.0-9.2.3]', async () => {
    const tool = await loadTool();
    expect(tool.V0_TOKEN_ISSUER).toBe(ISSUER);
    const { privateJwk, jwks } = tool.generateV0TokenKey();
    // 환경 값(JSON)으로 넣었다가 읽는 길 그대로
    const parsed = parseFanJwks(JSON.stringify(jwks));
    const verify = createTokenVerifier({ jwks: parsed, issuer: tool.V0_TOKEN_ISSUER, clock: fakeClock({ now: TOOL_NOW_MS }) });
    const token = tool.signV0Token(privateJwk, { sub: 'acc-tool', sid: 'sess-tool', scope: 'ticket:buy', pid: 'pid-tool' }, { nowMs: TOOL_NOW_MS });
    expect(verify(token)).toEqual({ ok: true, identity: { sub: 'acc-tool', sid: 'sess-tool', scope: 'ticket:buy', pid: 'pid-tool' } });
  });

  test('BSL050_도구_토큰은_15분_뒤_만료된다 [ASVS v5.0.0-9.2.1]', async () => {
    const tool = await loadTool();
    const { privateJwk, jwks } = tool.generateV0TokenKey();
    const clock = fakeClock({ now: TOOL_NOW_MS });
    const verify = createTokenVerifier({ jwks: parseFanJwks(JSON.stringify(jwks)), issuer: ISSUER, clock });
    const token = tool.signV0Token(privateJwk, { sub: 'acc-tool', sid: 'sess-tool' }, { nowMs: TOOL_NOW_MS });
    clock.advance((tool.V0_TOKEN_TTL_SECONDS - 1) * 1000);
    expect(verify(token).ok).toBe(true);
    clock.advance(1000);
    expect(verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  test('BSL050_도구로_머리를_틀리게_만든_토큰과_개인키_목록은_입구가_받지_않는다 [ASVS v5.0.0-9.1.2]', async () => {
    const tool = await loadTool();
    const { privateJwk, jwks } = tool.generateV0TokenKey();
    const verify = createTokenVerifier({ jwks: parseFanJwks(JSON.stringify(jwks)), issuer: ISSUER, clock: fakeClock({ now: TOOL_NOW_MS }) });
    expect(verify(tool.signV0Token(privateJwk, { sub: 'a', sid: 's' }, { nowMs: TOOL_NOW_MS, header: { typ: 'JWT' } }))).toEqual({ ok: false, reason: 'typ' });
    expect(verify(tool.signV0Token(privateJwk, { sub: 'a', sid: 's', aud: 'partner' }, { nowMs: TOOL_NOW_MS }))).toEqual({ ok: false, reason: 'audience' });
    // 개인키 JWK를 공개키 목록 자리에 잘못 넣으면 입구가 시작하지 않는다
    expect(() => parseFanJwks(JSON.stringify({ keys: [privateJwk] }))).toThrow(JwksError);
  });
});
