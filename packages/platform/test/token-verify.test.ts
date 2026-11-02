// 받는 쪽 토큰 확인(docs/features/identity.md §3 '게이트웨이 무상태 고속 검증'·'토큰 수명주기 구현' 발급자와 검증 규칙, ADR-0050 결정 9).
// 키 셋(팬·관리·현장 스태프)마다 자기 공개키만 믿고, typ·iss·aud·ES256을 함께 본다.
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { beforeAll, describe, expect, test } from 'vitest';
import { fakeClock } from '../src/clock.js';
import { TokenRejected, TokenVerifier } from '../src/token-verify.js';

const ISS = 'https://identity.peaket.test';
const clock = fakeClock({ now: Date.parse('2026-11-03T03:00:00Z') });
const nowS = () => Math.floor(clock.now() / 1000);

interface Key {
  kid: string;
  priv: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  pub: JWK;
}
async function key(kid: string): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return { kid, priv: privateKey, pub: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' } };
}
const sign = (k: Key, o: { typ?: string; aud?: string; iss?: string; exp?: number; claims?: Record<string, unknown> } = {}) =>
  new SignJWT({ sid: 's-1', ...o.claims })
    .setProtectedHeader({ alg: 'ES256', typ: o.typ ?? 'at+jwt', kid: k.kid })
    .setIssuer(o.iss ?? ISS)
    .setSubject('acc-1')
    .setAudience(o.aud ?? 'fan')
    .setIssuedAt(nowS())
    .setExpirationTime(o.exp ?? nowS() + 900)
    .sign(k.priv);

let fan: Key;
let fanOld: Key;
let admin: Key;
let admission: Key;
let verifier: TokenVerifier;
const fetched: string[] = [];

beforeAll(async () => {
  [fan, fanOld, admin, admission] = await Promise.all([key('fan-2'), key('fan-1'), key('admin-1'), key('adm-1')]);
  verifier = new TokenVerifier({
    issuer: ISS,
    clock,
    jwks: async (set) => {
      fetched.push(set);
      return { fan: { keys: [fan.pub, fanOld.pub] }, admin: { keys: [admin.pub] }, staff: { keys: [] } }[set];
    },
  });
});

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof TokenRejected) return e.reason;
    throw e;
  }
};

describe('토큰 확인(받는 쪽)', () => {
  test('I-T36_ADR0050_팬키로서명한ops토큰과_입장토큰을액세스토큰자리에넣은요청은_거절한다 [ASVS v5.0.0-9.2.2]', async () => {
    // 팬 키로 서명한 aud ops 토큰: 관리 키 셋에는 그 kid가 없다(키 불일치)
    expect(await reason(verifier.verifyAccess(await sign(fan, { aud: 'ops' }), { keySet: 'admin', audience: 'ops' }))).toBe('kid');
    // 입장 토큰(typ admission+jwt, aud purchase)을 팬 액세스 토큰 자리에: typ 불일치
    expect(await reason(verifier.verifyAccess(await sign(admission, { typ: 'admission+jwt', aud: 'purchase' }), { keySet: 'fan', audience: 'fan' }))).toBe('kid');
    expect(await reason(verifier.verifyAccess(await sign(fan, { typ: 'admission+jwt' }), { keySet: 'fan', audience: 'fan' }))).toBe('typ');
    // 발급자가 다르면 iss 불일치
    expect(await reason(verifier.verifyAccess(await sign(fan, { iss: 'https://evil.example' }), { keySet: 'fan', audience: 'fan' }))).toBe('iss');
  });

  test('I-T19_같은관리키로서명한파트너토큰을ops에내면_aud불일치로거절한다 [ASVS v5.0.0-9.2.3] [ASVS v5.0.0-9.2.4]', async () => {
    expect(await reason(verifier.verifyAccess(await sign(admin, { aud: 'partner' }), { keySet: 'admin', audience: 'ops' }))).toBe('aud');
    expect(await reason(verifier.verifyAccess(await sign(admin, { aud: 'ops' }), { keySet: 'admin', audience: 'ops' }))).toBe('OK');
    // 키 셋이 받지 않는 대상은 부를 수 없다(팬 키 셋은 fan만)
    await expect(verifier.verifyAccess(await sign(fan), { keySet: 'fan', audience: 'ops' as 'fan' })).rejects.toThrow(/대상/);
  });

  test('I-T20_교체전kid로서명한토큰도공개키묶음에있으면받고_만료·서명불일치·ES256밖은거절한다 [ASVS v5.0.0-9.1.1] [ASVS v5.0.0-9.1.2] [ASVS v5.0.0-9.2.1]', async () => {
    const ok = await verifier.verifyAccess(await sign(fanOld), { keySet: 'fan', audience: 'fan' });
    expect(ok).toMatchObject({ accountId: 'acc-1', sessionId: 's-1', audience: 'fan' });
    expect(await reason(verifier.verifyAccess(await sign(fan, { exp: nowS() - 1 }), { keySet: 'fan', audience: 'fan' }))).toBe('expired');
    const t = await sign(fan);
    expect(await reason(verifier.verifyAccess(`${t.slice(0, -4)}AAAA`, { keySet: 'fan', audience: 'fan' }))).toBe('signature');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt', kid: 'fan-2' })).toString('base64url')}.${t.split('.')[1]}.`;
    expect(await reason(verifier.verifyAccess(none, { keySet: 'fan', audience: 'fan' }))).toBe('alg');
    expect(await reason(verifier.verifyAccess('not-a-jwt', { keySet: 'fan', audience: 'fan' }))).toBe('format');
  });

  test('identity§7.1_재인증토큰은_typ_reauth+jwt이고_세션과작업묶음이요청과같아야한다', async () => {
    const r = await sign(fan, { typ: 'reauth+jwt', claims: { act: 'FAN_HIGH_RISK', provider: 'kakao', strength: 'verified', jti: 'j-1' } });
    expect(await verifier.verifyReauth(r, { keySet: 'fan', audience: 'fan', sessionId: 's-1', act: 'FAN_HIGH_RISK' })).toMatchObject({ jti: 'j-1', strength: 'verified', provider: 'kakao' });
    expect(await reason(verifier.verifyReauth(r, { keySet: 'fan', audience: 'fan', sessionId: 's-2', act: 'FAN_HIGH_RISK' }))).toBe('claims');
    expect(await reason(verifier.verifyReauth(r, { keySet: 'fan', audience: 'fan', sessionId: 's-1', act: 'FAN_SENSITIVE' }))).toBe('claims');
    // 액세스 토큰을 재인증 토큰 자리에 넣으면 typ 불일치
    expect(await reason(verifier.verifyReauth(await sign(fan), { keySet: 'fan', audience: 'fan', sessionId: 's-1', act: 'FAN_SENSITIVE' }))).toBe('typ');
  });

  test('I-T20_공개키묶음은_키셋마다캐시하고_모르는kid가오면한번다시읽는다', async () => {
    const before = fetched.filter((s) => s === 'fan').length;
    await verifier.verifyAccess(await sign(fan), { keySet: 'fan', audience: 'fan' });
    expect(fetched.filter((s) => s === 'fan').length).toBe(before);
    const unknown = await key('fan-3');
    expect(await reason(verifier.verifyAccess(await sign(unknown), { keySet: 'fan', audience: 'fan' }))).toBe('kid');
    expect(fetched.filter((s) => s === 'fan').length).toBe(before + 1);
  });
});

describe('공개키 묶음 다시 읽기(새 맥락 리뷰 2026-11-03)', () => {
  test('I-T20_모르는kid가거듭와도_30초안에는다시읽지않고_동시에온요청은한번만읽는다', async () => {
    let n = 0;
    const v = new TokenVerifier({ issuer: ISS, clock, jwks: async () => (n++, { keys: [fan.pub] }) });
    await v.verifyAccess(await sign(fan), { keySet: 'fan', audience: 'fan' });
    expect(n).toBe(1);
    const stranger = await key('fan-x');
    const forged = await sign(stranger);
    await Promise.all(Array.from({ length: 5 }, () => reason(v.verifyAccess(forged, { keySet: 'fan', audience: 'fan' }))));
    expect(n).toBe(2);
    for (let i = 0; i < 5; i++) expect(await reason(v.verifyAccess(forged, { keySet: 'fan', audience: 'fan' }))).toBe('kid');
    expect(n).toBe(2);
    clock.advance(30_001);
    await reason(v.verifyAccess(forged, { keySet: 'fan', audience: 'fan' }));
    expect(n).toBe(3);
  });

  test('I-T20_다시읽기가실패하면_마지막으로받은키로계속확인하고_모르는kid는거절한다', async () => {
    let up = true;
    const v = new TokenVerifier({
      issuer: ISS,
      clock,
      jwks: async () => {
        if (!up) throw new Error('identity-svc 응답 없음');
        return { keys: [fan.pub] };
      },
    });
    await v.verifyAccess(await sign(fan), { keySet: 'fan', audience: 'fan' });
    up = false;
    clock.advance(6 * 60_000);
    expect(await reason(v.verifyAccess(await sign(fan), { keySet: 'fan', audience: 'fan' }))).toBe('OK');
    expect(await reason(v.verifyAccess(await sign(await key('fan-y')), { keySet: 'fan', audience: 'fan' }))).toBe('kid');
  });

  test('ASVS v5.0.0-9.2.1_exp가없는토큰은_거절한다', async () => {
    const noExp = await new SignJWT({ sid: 's-1', act: 'FAN_SENSITIVE', jti: 'j' })
      .setProtectedHeader({ alg: 'ES256', typ: 'reauth+jwt', kid: fan.kid })
      .setIssuer(ISS)
      .setSubject('acc-1')
      .setAudience('fan')
      .sign(fan.priv);
    expect(await reason(verifier.verifyReauth(noExp, { keySet: 'fan', audience: 'fan', sessionId: 's-1', act: 'FAN_SENSITIVE' }))).toBe('claims');
  });
});
