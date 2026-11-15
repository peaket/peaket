// TEST-06 보강: BOOKER_EXPORT 재인증 어댑터의 부정 경로(패스키 없음·세션·대상·typ·모르는 kid)를 실제 JWKS로 고정한다.
// 감사 TEST-06의 수정은 시험 추가 자체였으므로 이 파일은 수정 전 커밋에서도 통과한다(production 코드는 R-588부터 같다).
import { createSign, generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { AttendeeExports } from '../src/modules/export/application/attendee-exports.js';
import { JwksBookersReauth, MemoryActorNames, MemoryAttendeeExportStore, MemoryPartnerEventLookup, UnavailableBookersReauth } from '../src/modules/export/index.js';
import { ExportProblem } from '../src/modules/export/domain/export.js';
import type { AttendeeSource } from '../src/modules/export/domain/ports.js';

const ISS = 'https://identity.peaket.test';
const ACCOUNT = randomUUID();
const TENANT = randomUUID();
const EVENT = randomUUID();
const clock = fakeClock({ now: Date.parse('2026-11-15T00:00:00Z') });
const nowS = () => Math.floor(clock.now() / 1000);

interface Key {
  kid: string;
  priv: KeyObject;
  pub: Record<string, unknown>;
}
function key(kid: string): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, priv: privateKey, pub: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } };
}
const b64 = (v: string | Buffer): string => Buffer.from(v).toString('base64url');
const sign = (
  k: Key,
  o: { sub?: string; sid?: string; aud?: string; typ?: string; act?: string; exp?: number; factors?: string[] } = {},
) => {
  const header = b64(JSON.stringify({ alg: 'ES256', typ: o.typ ?? 'reauth+jwt', kid: k.kid }));
  const payload = b64(
    JSON.stringify({
      iss: ISS,
      sub: o.sub ?? ACCOUNT,
      aud: o.aud ?? 'partner',
      iat: nowS(),
      exp: o.exp ?? nowS() + 300,
      sid: o.sid ?? 's-1',
      jti: randomUUID(),
      act: o.act ?? 'BOOKER_EXPORT',
      factors: o.factors ?? ['password', 'totp', 'passkey'],
    }),
  );
  const signature = createSign('SHA256').update(`${header}.${payload}`).sign({ key: k.priv, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64(signature)}`;
};

const admin = key('admin-1');
const unknown = key('unknown-1');
const jwks = { keys: [admin.pub] };
const reauth = new JwksBookersReauth({
  jwksUrl: `${ISS}/internal/jwks/admin.json`,
  issuer: ISS,
  clock,
  fetch: (async () => new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
});

const status = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof ExportProblem) return `${e.status}:${e.type}`;
    throw e;
  }
};

const verify = (token: string | undefined) => reauth.verify(token, { sessionId: 's-1', promoterId: TENANT });

describe('TEST-06 BOOKER_EXPORT 재인증 부정 경로', () => {
  test('패스키가 없으면 403이다', async () => {
    expect(await status(verify(await sign(admin, { factors: ['password', 'totp'] })))).toBe('403:reauth-required');
    expect(await status(verify(await sign(admin, { factors: [] })))).toBe('403:reauth-required');
  });

  test('세션·대상·typ이 다르면 403이다', async () => {
    expect(await status(verify(await sign(admin, { sid: 's-2' })))).toBe('403:reauth-required');
    expect(await status(verify(await sign(admin, { aud: 'ops' })))).toBe('403:reauth-required');
    expect(await status(verify(await sign(admin, { typ: 'at+jwt' })))).toBe('403:reauth-required');
  });

  test('모르는 kid·빈 토큰·미조립 어댑터는 403이다', async () => {
    expect(await status(verify(await sign(unknown)))).toBe('403:reauth-required');
    expect(await status(verify(undefined))).toBe('403:reauth-required');
    expect(await status(new UnavailableBookersReauth().verify())).toBe('403:reauth-required');
  });

  test('유스케이스도 패스키 없는 재인증을 403으로 거절한다', async () => {
    const events = new MemoryPartnerEventLookup();
    events.add(TENANT, EVENT, 'LUMEN', new Date('2026-12-01T00:00:00Z'));
    const attendees: AttendeeSource = { list: async () => ({ items: [], nextCursor: null }), count: async () => ({ bookings: 0, tickets: 0 }) };
    const app = new AttendeeExports({ store: new MemoryAttendeeExportStore(), attendees, events, reauth, actors: new MemoryActorNames(), clock });
    await expect(
      app.create(TENANT, EVENT, { accountId: ACCOUNT, sessionId: 's-1', role: 'partner_admin' }, await sign(admin, { factors: ['password'] }), { reason: '확인', format: 'CSV' }),
    ).rejects.toMatchObject({ status: 403, type: 'https://peaket.example/problems/reauth-required' });
  });
});
