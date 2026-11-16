// TEST-06: BOOKER_EXPORT 재인증을 실제 JwksBookersReauth·가짜 JWKS로 태운다.
import { createSign, generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { AttendeeExports } from '../src/modules/export/application/attendee-exports.js';
import { JwksBookersReauth, MemoryActorNames, MemoryAttendeeExportStore, MemoryPartnerEventLookup } from '../src/modules/export/index.js';
import { ExportProblem } from '../src/modules/export/domain/export.js';
import type { AttendeeSource } from '../src/modules/export/domain/ports.js';

const ISS = 'https://identity.peaket.test';
const ACCOUNT = randomUUID();
const OTHER = randomUUID();
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
const sign = (k: Key, o: { sub?: string; act?: string; exp?: number; factors?: string[] } = {}) => {
  const header = b64(JSON.stringify({ alg: 'ES256', typ: 'reauth+jwt', kid: k.kid }));
  const payload = b64(
    JSON.stringify({
      iss: ISS,
      sub: o.sub ?? ACCOUNT,
      aud: 'partner',
      iat: nowS(),
      exp: o.exp ?? nowS() + 300,
      sid: 's-1',
      jti: randomUUID(),
      act: o.act ?? 'BOOKER_EXPORT',
      factors: o.factors ?? ['password', 'totp', 'passkey'],
    }),
  );
  const signature = createSign('SHA256').update(`${header}.${payload}`).sign({ key: k.priv, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64(signature)}`;
};

const admin = key('admin-1');
const stranger = key('stranger-1');
const jwks = { keys: [admin.pub] };
const reauth = new JwksBookersReauth({
  jwksUrl: `${ISS}/internal/jwks/admin.json`,
  issuer: ISS,
  clock,
  fetch: (async () => new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
});

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof ExportProblem) return `${e.status}:${e.type}`;
    throw e;
  }
};

describe('TEST-06 BOOKER_EXPORT 실제 재인증', () => {
  test('정상 토큰은 계정·factors를 돌려주고, 서명·만료·act가 틀리면 403이다', async () => {
    expect(await reauth.verify(await sign(admin), { sessionId: 's-1', promoterId: TENANT })).toEqual({ accountId: ACCOUNT, factors: ['password', 'totp', 'passkey'] });
    expect(await reason(reauth.verify(await sign(stranger), { sessionId: 's-1', promoterId: TENANT }))).toBe('403:reauth-required');
    expect(await reason(reauth.verify(await sign(admin, { exp: nowS() - 1 }), { sessionId: 's-1', promoterId: TENANT }))).toBe('403:reauth-required');
    expect(await reason(reauth.verify(await sign(admin, { act: 'FAN_HIGH_RISK' }), { sessionId: 's-1', promoterId: TENANT }))).toBe('403:reauth-required');
  });

  test('다른 계정의 토큰으로 내려받으면 403이다', async () => {
    const store = new MemoryAttendeeExportStore();
    const events = new MemoryPartnerEventLookup();
    events.add(TENANT, EVENT, 'LUMEN', new Date('2026-12-01T00:00:00Z'));
    const attendees: AttendeeSource = { list: async () => ({ items: [], nextCursor: null }), count: async () => ({ bookings: 0, tickets: 0 }) };
    const app = new AttendeeExports({ store, attendees, events, reauth, actors: new MemoryActorNames(), clock });
    await expect(app.create(TENANT, EVENT, { accountId: OTHER, sessionId: 's-1', role: 'partner_admin', clientIp: '198.51.100.20' }, await sign(admin), { reason: '확인', format: 'CSV' })).rejects.toMatchObject({ status: 403 });
  });
});
