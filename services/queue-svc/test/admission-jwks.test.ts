// 입장 토큰 공개키 묶음과 키 교체 설정(Q-T69 ①, docs/features/queue-admission.md §6 '입장 토큰 공개키 묶음과 게이트웨이 확인'의 '키 설정'·'묶음 배포',
// ADR-0288 결정 1·2, docs/security/asvs/queue-admission.md 9.1.3, BUILD_ORDER HOT-400 묶음 BAT-057 계획 §6 U3·U4·U6·U7).
// 값(경로 /internal/jwks/admission.json, Cache-Control max-age=300, 끝 시각 상한 지금 + 45분 + 1일 + 1시간, 환경 값 이름)은 정본에서 그대로 적는다(코드 상수를 가져오지 않는다).
// 설정은 시작 때처럼 환경 값(fromEnv)으로 넣고, 묶음은 앱 포트의 HTTP 경로(바깥 경계)로 읽는다. 시험이 고르는 끝 시각은 상한과 다른 값이다.
import 'reflect-metadata';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { TestSeedSealer } from '@peaket/shuffle';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Es256AdmissionTokens } from '../src/modules/admission/index.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { recordingRisk, tokens } from './support.js';

// ---- 정본 값(docs/features/queue-admission.md §6) ----
const KEY = 'PEAKET_ADMISSION_TOKEN_KEY';
const ISSUER = 'PEAKET_ADMISSION_TOKEN_ISSUER';
const PREVIOUS = 'PEAKET_ADMISSION_TOKEN_KEY_PREVIOUS';
const PREVIOUS_UNTIL = 'PEAKET_ADMISSION_TOKEN_KEY_PREVIOUS_UNTIL';
const NEXT = 'PEAKET_ADMISSION_TOKEN_KEY_NEXT';
const JWKS_PATH = '/internal/jwks/admission.json';
/** 원소에 실을 수 있는 칸(공개 부분). 옛 키 원소에만 peaket_until */
const PUBLIC_FIELDS = ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y'];
/** 옛 키 끝 시각의 상한: 지금 + 최대 체류 45분 + 1일 + 1시간 */
const UNTIL_MAX_MS = 45 * 60_000 + 24 * 3_600_000 + 3_600_000;

const quiet = new Writable({ write: (_c, _e, cb) => cb() });
/** 지금(밀리초 0). 시험의 끝 시각 T = 지금 + 7시간 13분 17초(상한과 다른 값) */
const NOW = Date.parse('2026-11-19T01:00:00.000Z');
const T = NOW + (7 * 3600 + 13 * 60 + 17) * 1000;

function newKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const priv: Record<string, string> = { ...(privateKey.export({ format: 'jwk' }) as Record<string, string>), kid };
  const { d: _d, ...pub } = priv as Record<string, string>;
  return { kid, priv, pub, publicKey };
}
const K1 = newKey('adm-k1'); // 옛 키
const K2 = newKey('adm-k2'); // 지금 키
const K3 = newKey('adm-k3'); // 다음 키
const iso = (ms: number) => new Date(ms).toISOString();

/** 키를 바꾸는 동안의 설정: 지금 K2, 옛 K1(끝 시각 until, null이면 끝 시각 칸을 두지 않는다), 다음 K3 */
const rotating = (until: string | null = iso(T)): Record<string, string | undefined> => ({
  [KEY]: JSON.stringify(K2.priv),
  [ISSUER]: 'https://queue.peaket.example',
  [PREVIOUS]: JSON.stringify(K1.pub),
  ...(until === null ? {} : { [PREVIOUS_UNTIL]: until }),
  [NEXT]: JSON.stringify(K3.pub),
});

async function serviceWith(env: Record<string, string | undefined>, nowMs: number) {
  const clock = fakeClock({ now: nowMs });
  const signer = Es256AdmissionTokens.fromEnv(env, nowMs);
  const svc = await createService({
    name: 'queue-svc',
    module: AppModule.register({ memory: true, schedules: new MemoryEventSchedules(), tokens, risk: recordingRisk(), sealer: new TestSeedSealer(Buffer.alloc(32, 4)), admission: { signer } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
  return { svc, clock, signer };
}

type Jwks = { keys: Record<string, unknown>[] };
const kidsOf = (b: Jwks) => b.keys.map((k) => k.kid).sort();

describe('Q-T69 ① 공개키 묶음 GET /internal/jwks/admission.json', () => {
  let s: Awaited<ReturnType<typeof serviceWith>>;
  beforeAll(async () => {
    s = await serviceWith(rotating(), NOW);
  });
  afterAll(async () => {
    await s?.svc.close();
  });

  test('Q-T69 ① [ASVS v5.0.0-9.1.3] 묶음은 지금·다음·옛 키의 공개 부분(kty·crv·x·y·kid·alg·use)만 싣고 d가 없으며 Cache-Control: max-age=300이다. 옛 키 원소에만 peaket_until이 있다', async () => {
    const r = await s.svc.http.inject({ method: 'GET', url: JWKS_PATH });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('max-age=300');
    expect(String(r.headers['content-type'])).toMatch(/^application\/json\b/);
    const body = JSON.parse(r.payload) as Jwks;
    expect(Object.keys(body)).toEqual(['keys']);
    expect(kidsOf(body)).toEqual(['adm-k1', 'adm-k2', 'adm-k3']);
    expect(r.payload).not.toContain('"d"');
    for (const k of body.keys) {
      const own = [K1, K2, K3].find((x) => x.kid === k.kid)!;
      const fields = Object.keys(k).sort();
      expect(fields, String(k.kid)).toEqual(k.kid === 'adm-k1' ? [...PUBLIC_FIELDS, 'peaket_until'].sort() : PUBLIC_FIELDS);
      expect(k, String(k.kid)).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', x: own.pub.x, y: own.pub.y });
    }
    expect(body.keys.find((k) => k.kid === 'adm-k1')!.peaket_until).toBe(T / 1000);
  });

  test('Q-T69 ① [ASVS v5.0.0-9.1.3] 묶음의 지금 키 원소로 서명기가 낸 입장 토큰의 서명이 맞는다(공개 부분이 서명 키의 것이다)', async () => {
    const res = await s.svc.http.inject({ method: 'GET', url: JWKS_PATH });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as Jwks;
    const { token } = s.signer.sign({ jti: 'j-jwks', accountId: 'acct-1', sessionId: 's-1', eventId: 'ev-1', jny: '0190f3a1-7c2e-7a00-8000-0000000000aa', nowMs: NOW });
    const [h, p, sig] = token.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString()).kid).toBe('adm-k2');
    const jwk = body.keys.find((k) => k.kid === 'adm-k2')!;
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  test('Q-T69 ① 다른 파일 이름(fan·admin·staff·대문자·덧붙인 이름)은 404이고 묶음이 나가지 않는다', async () => {
    for (const name of ['fan.json', 'admin.json', 'staff.json', 'ADMISSION.json', 'admission.json.bak', 'admission']) {
      const r = await s.svc.http.inject({ method: 'GET', url: `/internal/jwks/${name}` });
      expect(r.statusCode, name).toBe(404);
      expect(r.payload, name).not.toContain('adm-k2');
    }
  });
});

describe('Q-T69 ① 옛 키는 끝 시각까지만 묶음에 싣는다(가짜 시계 T − 1ms·T·T + 1ms)', () => {
  let s: Awaited<ReturnType<typeof serviceWith>>;
  beforeAll(async () => {
    s = await serviceWith(rotating(), NOW);
  });
  afterAll(async () => {
    await s?.svc.close();
  });
  const read = async () => {
    const r = await s.svc.http.inject({ method: 'GET', url: JWKS_PATH });
    expect(r.statusCode).toBe(200);
    return JSON.parse(r.payload) as Jwks;
  };

  test('Q-T69 ① T − 1ms·T에는 K1·K2·K3이고 K1에 peaket_until = T의 초, T + 1ms부터는 K2·K3뿐이다. 다음 키는 늘 있다', async () => {
    s.clock.advance(T - 1 - NOW);
    const before = await read();
    expect(kidsOf(before)).toEqual(['adm-k1', 'adm-k2', 'adm-k3']);
    expect(before.keys.find((k) => k.kid === 'adm-k1')!.peaket_until).toBe(T / 1000);
    s.clock.advance(1);
    const at = await read();
    expect(kidsOf(at)).toEqual(['adm-k1', 'adm-k2', 'adm-k3']);
    expect(at.keys.find((k) => k.kid === 'adm-k1')!.peaket_until).toBe(T / 1000);
    s.clock.advance(1);
    const after = await read();
    expect(kidsOf(after)).toEqual(['adm-k2', 'adm-k3']);
    for (const k of after.keys) expect(k.peaket_until, String(k.kid)).toBeUndefined();
  });
});

describe('Q-T69 ① 키 설정의 시작 검사(fromEnv가 던진다, 값은 문구에 싣지 않는다)', () => {
  const thrown = (env: Record<string, string | undefined>, nowMs = NOW): string | undefined => {
    try {
      Es256AdmissionTokens.fromEnv(env, nowMs);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  test('[ASVS v5.0.0-9.1.3] 옛 키·다음 키에 개인 성분 d가 있거나 지금·옛·다음 키의 kid가 겹치면 시작하지 않는다', () => {
    const cases: [string, Record<string, string | undefined>][] = [
      ['옛 키에 d', { ...rotating(), [PREVIOUS]: JSON.stringify(K1.priv) }],
      ['다음 키에 d', { ...rotating(), [NEXT]: JSON.stringify(K3.priv) }],
      ['옛 키 kid = 지금 키 kid', { ...rotating(), [PREVIOUS]: JSON.stringify({ ...K1.pub, kid: 'adm-k2' }) }],
      ['다음 키 kid = 지금 키 kid', { ...rotating(), [NEXT]: JSON.stringify({ ...K3.pub, kid: 'adm-k2' }) }],
      ['옛 키 kid = 다음 키 kid', { ...rotating(), [NEXT]: JSON.stringify({ ...K3.pub, kid: 'adm-k1' }) }],
    ];
    for (const [label, env] of cases) {
      const msg = thrown(env);
      expect(msg, `${label}: 시작했다`).toBeDefined();
      // 개인 성분·좌표 값이 오류 문구에 새지 않는다
      for (const v of [K1.priv.d, K2.priv.d, K3.priv.d, K1.pub.x, K3.pub.x]) expect(msg, label).not.toContain(v);
    }
    // 바른 설정은 시작한다(위 실패가 다른 까닭이 아니다)
    expect(thrown(rotating())).toBeUndefined();
  });

  test('Q-T69 ① [ASVS v5.0.0-9.2.1] 옛 키가 있는데 끝 시각이 없거나 밀리초가 0이 아니거나 지금 + 45분 + 1일 + 1시간 + 1초면 시작하지 않고, 정확히 지금 + 45분 + 1일 + 1시간은 받는다', () => {
    expect(thrown(rotating(null)), '끝 시각 없음').toBeDefined();
    expect(thrown(rotating('')), '끝 시각 빈 글').toBeDefined();
    expect(thrown(rotating('not-a-time')), '끝 시각 꼴 아님').toBeDefined();
    expect(thrown(rotating(iso(T + 500))), '밀리초 500').toBeDefined();
    expect(thrown(rotating(iso(T + 1))), '밀리초 1').toBeDefined();
    expect(thrown(rotating(iso(NOW + UNTIL_MAX_MS + 1000))), '상한 + 1초').toBeDefined();
    expect(thrown(rotating(iso(NOW + UNTIL_MAX_MS))), '정확히 상한').toBeUndefined();
    expect(thrown(rotating(iso(T))), '상한 안').toBeUndefined();
  });

  test('Q-T69 ① R057-6 R057-9 끝 시각은 날짜·시각(초까지)·시간대가 다 있는 ISO 8601만 받는다: 시간대 없음·날짜만·RFC 2822 글·초 없음·0이 아닌 소수 초(.0001·.000000001)·달력에 없는 날(2월 30일)·24시면 시작하지 않고(문구에 키 값 없음), 같은 시각의 Z·+09:00·0인 소수 초 꼴은 시작한다', () => {
    // 같은 시각 2026-11-19T10:00:00Z(지금 + 9시간, 상한 안)를 여러 꼴로 적는다
    // R057-9: 밀리초 아래 자리만 0이 아닌 소수 초(Date.parse가 밀리초로 잘라 0이 된다)와 달력에 없는 날·시각(Date.parse가 다음 날로 넘긴다)도 시작하지 않는다.
    // 끝 시각은 지금(11-19 01:00Z)부터 상한(+ 25시간 45분) 안의 값이라 상한 검사가 아니라 꼴 검사로 거절되는지를 본다(2월 30일은 지난 시각이라 상한에 걸리지 않는다)
    const calendar = ['2026-11-19T10:00:00.0001Z', '2026-11-19T10:00:00.000000001Z', '2026-02-30T10:00:00Z', '2026-11-19T24:00:00Z'];
    for (const bad of ['2026-11-19T10:00:00', '2026-11-19', 'Thu, 19 Nov 2026 10:00:00 GMT', '2026-11-19T10:00Z', ...calendar]) {
      const msg = thrown(rotating(bad));
      expect(msg, `${bad}: 시작했다`).toBeDefined();
      for (const v of [K1.priv.d, K2.priv.d, K3.priv.d, K1.pub.x, K2.pub.x]) expect(msg, bad).not.toContain(v);
    }
    for (const ok of ['2026-11-19T10:00:00Z', '2026-11-19T19:00:00+09:00', '2026-11-19T10:00:00.000Z', '2026-11-19T10:00:00.000000000Z']) expect(thrown(rotating(ok)), ok).toBeUndefined();
  });

  test('[ASVS v5.0.0-9.1.3] R057-7 옛 키·다음 키가 P-256 공개키로 읽히지 않으면(곡선 밖 좌표: 한 키의 x와 다른 키의 y, x가 31바이트) 시작하지 않고 문구에 좌표 값이 없다', () => {
    const offCurve = (k: { pub: Record<string, string> }, other: { pub: Record<string, string> }) => JSON.stringify({ ...k.pub, y: other.pub.y });
    const short = (k: { pub: Record<string, string> }) => JSON.stringify({ ...k.pub, x: Buffer.alloc(31, 7).toString('base64url') });
    const cases: [string, Record<string, string | undefined>][] = [
      ['옛 키 곡선 밖', { ...rotating(), [PREVIOUS]: offCurve(K1, K3) }],
      ['옛 키 x 31바이트', { ...rotating(), [PREVIOUS]: short(K1) }],
      ['다음 키 곡선 밖', { ...rotating(), [NEXT]: offCurve(K3, K1) }],
      ['다음 키 x 31바이트', { ...rotating(), [NEXT]: short(K3) }],
    ];
    for (const [label, env] of cases) {
      const msg = thrown(env);
      expect(msg, `${label}: 시작했다`).toBeDefined();
      for (const v of [K1.pub.x, K1.pub.y, K3.pub.x, K3.pub.y, Buffer.alloc(31, 7).toString('base64url')]) expect(msg, label).not.toContain(v);
    }
    expect(thrown(rotating())).toBeUndefined();
  });
});
