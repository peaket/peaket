// 입장 토큰 공개키 묶음 주기 읽기(Q-T69 ③④⑤, docs/features/seat-hold.md §2 '입장 토큰 공개키 묶음 주기 읽기', ADR-0288 결정 3·7, BUILD_ORDER HOT-400·PRF-137,
// 묶음 BAT-057 계획 §6 U8·U9·U11·U12). 대역 묶음 서버는 이 시험이 넣는 fetch이고, 시각·타이머는 vitest 가짜 타이머(Date와 setTimeout을 함께)로 몬다.
// 정본 값(시험이 적는다. 코드 상수를 가져오지 않는다): 받기 전 1초마다, 받은 뒤 5분마다, 한 번 읽기 1초 한도, 실패 뒤 30초, 모르는 kid 다시 읽기 30초에 한 번·기다림 1초,
// 지표 purchase_admission_jwks_fetch_failures_total{reason: error·timeout·invalid}·purchase_admission_jwks_age_seconds, 환경 값 PEAKET_ADMISSION_JWKS_URL·PEAKET_ADMISSION_JWKS.
// 판정은 바깥 경계(대역 서버가 받은 요청 수와 시각, 마지막 묶음으로 실제 토큰을 확인한 결과, 지표 글)로 본다.
import { randomUUID } from 'node:crypto';
import { PlatformMetrics } from '@peaket/platform';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AdmissionJwksLoader, admissionKeysFromEnv, AdmissionKeysUnavailable, AdmissionTokenRejected, verifyAdmissionToken } from '../src/modules/inventory/index.js';
import { claimsOf, ISS, newKey, signAdmission, type TestKey } from './admission-fixtures.js';

// ---- 정본 값(docs/features/seat-hold.md §2 '입장 토큰 공개키 묶음 주기 읽기') ----
const FIRST_RETRY_MS = 1_000;
const REFRESH_MS = 5 * 60_000;
const TIMEOUT_MS = 1_000;
const RETRY_MS = 30_000;
const UNKNOWN_KID_MS = 30_000;
const UNKNOWN_KID_WAIT_MS = 1_000;
const URL_ENV = 'PEAKET_ADMISSION_JWKS_URL';
const STATIC_ENV = 'PEAKET_ADMISSION_JWKS';
const URL = 'http://queue-svc.queue.svc.cluster.local:8080/internal/jwks/admission.json';

/** 시작 시각(가짜 시계). 밀리초까지 정해 둔다 */
const START = Date.parse('2026-11-19T02:00:00.000Z');

const KA = newKey('kid-a');
const KB = newKey('kid-b');
const KC = newKey('kid-c');
const KD = newKey('kid-d');
const KP = newKey('kid-p');
const jwk = (k: TestKey, extra: Record<string, unknown> = {}) => ({ ...k.publicJwk, alg: 'ES256', use: 'sig', ...extra });
const bundle = (...keys: Record<string, unknown>[]) => JSON.stringify({ keys });

type Reply = { status: number; body: string } | { hang: true } | { refuse: true } | { gate: Promise<{ status: number; body: string }> };
/** 대역 묶음 서버: 받은 요청을 적고 지금 reply로 답한다 */
function standIn(initial: Reply) {
  const calls: { at: number; url: string; method: string }[] = [];
  let reply: Reply = initial;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ at: Date.now(), url: String(input), method: init?.method ?? 'GET' });
    const r = reply;
    if ('hang' in r) return new Promise<Response>(() => {});
    if ('refuse' in r) throw new TypeError('fetch failed');
    const v = 'gate' in r ? await r.gate : r;
    return new Response(v.body, { status: v.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    set(r: Reply) {
      reply = r;
    },
  };
}
const ok = (body: string): Reply => ({ status: 200, body });
function deferred() {
  let resolve!: (v: { status: number; body: string }) => void;
  const gate = new Promise<{ status: number; body: string }>((r) => (resolve = r));
  return { reply: { gate } as Reply, resolve };
}

/** 그 키로 서명한 입장 토큰(지금 시각 기준, exp 45분) */
const tokenOf = (k: TestKey) => signAdmission(k, claimsOf({ nowMs: Date.now(), jti: randomUUID() }));
/** 확인 결과: 받으면 undefined, 거절이면 이유 */
function verdict(keys: ReturnType<AdmissionJwksLoader['keys']>, t: string): string | undefined {
  try {
    verifyAdmissionToken(t, { keys: keys!, issuer: ISS, nowMs: Date.now() });
    return undefined;
  } catch (e) {
    if (e instanceof AdmissionTokenRejected) return e.reason;
    throw e;
  }
}

let loaders: AdmissionJwksLoader[] = [];
function loaderWith(s: ReturnType<typeof standIn>) {
  const registry = new PlatformMetrics('t').registry;
  const l = new AdmissionJwksLoader({ url: URL, fetch: s.fetch, clock: { now: () => Date.now() }, registry });
  loaders.push(l);
  const metric = async (name: string, label = '') => {
    const text = await registry.metrics();
    const line = text.split('\n').find((x) => x.startsWith(`${name}${label} `) || x.startsWith(`${name}${label}\t`));
    return line === undefined ? undefined : Number(line.trim().split(/\s+/).at(-1));
  };
  const failures = async (reason: string) => metric('purchase_admission_jwks_fetch_failures_total', `{reason="${reason}"}`);
  const age = async () => metric('purchase_admission_jwks_age_seconds');
  return { l, failures, age };
}

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  loaders = [];
});
afterEach(async () => {
  for (const l of loaders) await Promise.race([l.stop(), vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2)]);
  vi.useRealTimers();
});

describe('Q-T69 ③ 읽는 때(시작 때 바로, 받기 전 1초, 받은 뒤 5분)', () => {
  test('Q-T69 ③ 시작 때 바로 읽고, 받은 뒤 299,999ms에는 다시 읽지 않고 300,000ms에 읽는다(그 뒤에도 5분마다)', async () => {
    const s = standIn(ok(bundle(jwk(KA))));
    const { l } = loaderWith(s);
    await l.start();
    expect(s.calls.length, '시작 때 바로').toBe(1);
    expect(s.calls[0]).toMatchObject({ url: URL, method: 'GET', at: START });
    expect(verdict(l.keys(), tokenOf(KA))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
    expect(s.calls.length, '299,999ms').toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls.length, '300,000ms').toBe(2);
    expect(s.calls[1]!.at).toBe(START + REFRESH_MS);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(s.calls.length, '600,000ms').toBe(3);
  });

  test('Q-T69 ③ 처음 받기 전에는 999ms에 다시 시도하지 않고 1,000ms에 한다. 받은 뒤에는 5분 주기로 바뀐다', async () => {
    const s = standIn({ status: 500, body: '{}' });
    const { l } = loaderWith(s);
    await l.start();
    expect(s.calls.length).toBe(1);
    expect(l.keys(), '받은 적 없음').toBeUndefined();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS - 1);
    expect(s.calls.length, '999ms').toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls.length, '1,000ms').toBe(2);
    // 받기 전에는 실패해도 1초 주기다(30초가 아니다)
    s.set(ok(bundle(jwk(KA))));
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    expect(s.calls.length, '2,000ms').toBe(3);
    expect(verdict(l.keys(), tokenOf(KA))).toBeUndefined();
    await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
    expect(s.calls.length, '받은 뒤 299,999ms').toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls.length, '받은 뒤 300,000ms').toBe(4);
  });
});

describe('Q-T69 ③ 읽기 실패(복구 경로 장애 주입: 500·시간 초과·빈 묶음·틀린 모양 뒤 새 kid의 정상 묶음)', () => {
  test('Q-T69 ③ 실패 동안 마지막 키로 확인이 이어지고 30초 뒤(29,999ms 아님) 다시 읽으며, 실패 수 지표가 이유마다 오르고, 정상 묶음 뒤 새 kid를 받는다. 끝 시각이 지난 옛 키는 마지막 묶음에 남아 있어도 받지 않는다', async () => {
    // 옛 키 P는 시작 + 400초가 끝 시각이다(초)
    const untilS = START / 1000 + 400;
    const s = standIn(ok(bundle(jwk(KA), jwk(KP, { peaket_until: untilS }))));
    const { l, failures, age } = loaderWith(s);
    await l.start();
    const tokenA = tokenOf(KA);
    const tokenP = tokenOf(KP);
    expect(verdict(l.keys(), tokenA)).toBeUndefined();
    expect(verdict(l.keys(), tokenP)).toBeUndefined();
    for (const r of ['error', 'timeout', 'invalid']) expect(await failures(r), `처음 ${r}`).toBe(0);

    // ① 5분 뒤 다시 읽기가 500이다
    s.set({ status: 500, body: '{"type":"about:blank"}' });
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(s.calls.length).toBe(2);
    expect(await failures('error')).toBe(1);
    expect(verdict(l.keys(), tokenA), '500 뒤 마지막 키').toBeUndefined();

    // ② 30초 뒤 다시 읽는다(29,999ms 아님). 이번에는 응답이 오지 않는다: 1초 뒤 시간 초과
    s.set({ hang: true });
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(s.calls.length, '실패 뒤 29,999ms').toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls.length, '실패 뒤 30,000ms').toBe(3);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(await failures('timeout'), '999ms에는 아직 시간 초과가 아니다').toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await failures('timeout'), '1초 한도').toBe(1);
    expect(verdict(l.keys(), tokenA), '시간 초과 뒤 마지막 키').toBeUndefined();

    // ③ 시간 초과로 끝난 때부터 30초 뒤: 빈 keys
    s.set(ok(bundle()));
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(s.calls.length, '시간 초과 뒤 29,999ms').toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls.length).toBe(4);
    expect(await failures('invalid')).toBe(1);
    expect(verdict(l.keys(), tokenA), '빈 묶음 뒤 마지막 키').toBeUndefined();

    // ④ 30초 뒤: 개인 성분 d가 섞인 틀린 모양(새 kid B가 들어 있어도 받지 않는다)
    s.set(ok(bundle(jwk(KA), { ...jwk(KB), d: 'AAAA' })));
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.calls.length).toBe(5);
    expect(await failures('invalid')).toBe(2);
    expect(verdict(l.keys(), tokenOf(KB)), '틀린 묶음의 kid는 받지 않는다').toBe('kid');
    expect(verdict(l.keys(), tokenA)).toBeUndefined();
    // 마지막으로 받은 때(START)부터 지난 초(실패한 읽기는 나이를 되돌리지 않는다)
    expect(await age()).toBeCloseTo((Date.now() - START) / 1000, 2);

    // ⑤ 끝 시각(시작 + 400초)이 지났다: P는 마지막 묶음에 남아 있어도 kid로 거절, A는 그대로
    s.set({ refuse: true });
    await vi.advanceTimersByTimeAsync(untilS * 1000 + 1 - Date.now());
    expect(s.calls.length, '아직 다음 읽기 전').toBe(5);
    expect(l.keys()!.has('kid-p'), 'P는 마지막 묶음에 남아 있다').toBe(true);
    expect(verdict(l.keys(), tokenP), '끝 시각 + 1ms').toBe('kid');
    expect(verdict(l.keys(), tokenA)).toBeUndefined();

    // ⑥ 다음 읽기(연결 거절)도 실패, 그 30초 뒤 새 kid B가 든 정상 묶음을 받는다
    const before = s.calls.length;
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.calls.length).toBeGreaterThan(before);
    expect(await failures('error')).toBe(2);
    s.set(ok(bundle(jwk(KA), jwk(KB))));
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(verdict(l.keys(), tokenOf(KB)), '정상 묶음 뒤 새 kid').toBeUndefined();
    expect(verdict(l.keys(), tokenA)).toBeUndefined();
    expect(l.keys()!.has('kid-p'), '새 묶음에는 P가 없다').toBe(false);
    // 나이는 마지막으로 받은 읽기(마지막 요청)부터 다시 센다
    expect(await age()).toBeCloseTo((Date.now() - s.calls.at(-1)!.at) / 1000, 2);
  });
});

describe('Q-T69 ⑤ 모르는 kid(하나로 묶고 30초에 한 번, 기다림 1초)', () => {
  test('Q-T69 ⑤ 모르는 kid 요청 다섯이 동시에 오면 다시 읽기는 한 번이고 다섯 모두 새 kid를 받는다. 그 뒤 29,999ms 안의 모르는 kid는 다시 읽지 않고 거절, 30,000ms에는 다시 읽는다', async () => {
    const s = standIn(ok(bundle(jwk(KA))));
    const { l } = loaderWith(s);
    await l.start();
    expect(s.calls.length).toBe(1);
    const g = deferred();
    s.set(g.reply);
    const t0 = Date.now();
    const five = Array.from({ length: 5 }, () => l.keysFor('kid-b'));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.calls.length, '동시 다섯 → 다시 읽기 하나').toBe(2);
    g.resolve({ status: 200, body: bundle(jwk(KA), jwk(KB)) });
    const maps = await Promise.all(five);
    for (const m of maps) expect(verdict(m, tokenOf(KB))).toBeUndefined();

    // 다시 읽기를 시작한 때부터 29,999ms: 모르는 kid C는 다시 읽지 않고 마지막 묶음을 준다(확인이 kid로 거절 → 401)
    s.set(ok(bundle(jwk(KA), jwk(KB), jwk(KC))));
    await vi.advanceTimersByTimeAsync(t0 + UNKNOWN_KID_MS - 1 - Date.now());
    const early = await l.keysFor('kid-c');
    expect(s.calls.length, '29,999ms').toBe(2);
    expect(verdict(early, tokenOf(KC))).toBe('kid');
    // 30,000ms: 다시 읽는다
    await vi.advanceTimersByTimeAsync(1);
    const late = await l.keysFor('kid-c');
    expect(s.calls.length, '30,000ms').toBe(3);
    expect(verdict(late, tokenOf(KC))).toBeUndefined();
  });

  test('Q-T69 ⑤ 모르는 kid의 다시 읽기가 1초를 넘기면 그 요청은 1초에 마지막 묶음으로 끝나 거절된다(999ms에는 아직 기다린다)', async () => {
    const s = standIn(ok(bundle(jwk(KA))));
    const { l } = loaderWith(s);
    await l.start();
    s.set({ hang: true });
    let done: ReturnType<AdmissionJwksLoader['keys']> | 'pending' = 'pending';
    const p = l.keysFor('kid-d').then((m) => {
      done = m;
      return m;
    });
    await vi.advanceTimersByTimeAsync(UNKNOWN_KID_WAIT_MS - 1);
    expect(done, '999ms').toBe('pending');
    expect(s.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    const m = await p;
    expect(verdict(m, tokenOf(KD)), '1초 넘은 다시 읽기').toBe('kid');
    expect(verdict(m, tokenOf(KA)), '마지막 묶음 그대로').toBeUndefined();
  });
});

describe('Q-T69 ④ 한 번도 받지 못했을 때', () => {
  test('Q-T69 ④ 받은 적이 없으면 keysFor가 AdmissionKeysUnavailable로 끝난다(돌던 읽기는 1초까지 기다린다)', async () => {
    const s = standIn({ hang: true });
    const { l } = loaderWith(s);
    void l.start();
    let err: unknown = 'pending';
    const p = l.keysFor('kid-a').catch((e: unknown) => {
      err = e;
    });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await p;
    expect(err).toBeInstanceOf(AdmissionKeysUnavailable);
    expect(l.keys()).toBeUndefined();
  });
});

describe('Q-T69 ④ PRF-137 시작 설정(정적 묶음은 local·ci만)', () => {
  const STATIC = bundle(jwk(KA));
  const thrown = (env: Record<string, string | undefined>): string | undefined => {
    // 규칙 함수가 없어서 던진 것(TypeError)을 '시작하지 않음'으로 세지 않는다
    expect(typeof admissionKeysFromEnv, '시작 설정 규칙 admissionKeysFromEnv가 없다').toBe('function');
    try {
      admissionKeysFromEnv(env, { fetch: standIn({ hang: true }).fetch });
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  test('Q-T69 ④ PRF-137 local·ci 밖(demo·prod·staging·PEAKET_ENV 없음)에서 주소가 없으면 정적 묶음이 있어도 시작하지 않는다', () => {
    for (const e of ['demo', 'prod', 'staging', undefined]) {
      expect(thrown({ PEAKET_ENV: e, [STATIC_ENV]: STATIC }), `${e} 정적만`).toMatch(URL_ENV);
      expect(thrown({ PEAKET_ENV: e }), `${e} 둘 다 없음`).toMatch(URL_ENV);
    }
  });

  test('Q-T69 ④ PRF-137 주소와 정적 묶음을 함께 두면 어느 환경에서도 시작하지 않는다', () => {
    // 문구가 두 이름을 함께 가리킨다(다른 까닭으로 멈춘 것이 아니다)
    for (const e of ['local', 'ci', 'demo', 'prod']) {
      const msg = thrown({ PEAKET_ENV: e, [URL_ENV]: URL, [STATIC_ENV]: STATIC });
      expect(msg, e).toMatch(URL_ENV);
      expect(msg, e).toMatch(new RegExp(`${STATIC_ENV}(?!_URL)`));
    }
  });

  test('Q-T69 ④ PRF-137 local·ci는 정적 묶음을 받고(그 키로 확인된다) 운영은 주소로 주기 읽기를 만든다(아직 읽지 않는다)', async () => {
    for (const e of ['local', 'ci']) {
      const r = admissionKeysFromEnv({ PEAKET_ENV: e, [STATIC_ENV]: STATIC });
      expect(r.loader, e).toBeUndefined();
      expect(verdict(r.keys as ReturnType<AdmissionJwksLoader['keys']>, tokenOf(KA)), e).toBeUndefined();
    }
    const s = standIn(ok(STATIC));
    const r = admissionKeysFromEnv({ PEAKET_ENV: 'prod', [URL_ENV]: URL }, { fetch: s.fetch });
    expect(r.loader).toBeInstanceOf(AdmissionJwksLoader);
    expect(r.keys).toBe(r.loader);
    loaders.push(r.loader!);
    expect(s.calls.length, '만들기만 하고 읽지 않는다').toBe(0);
    await r.loader!.start();
    expect(s.calls.map((c) => c.url)).toEqual([URL]);
  });

  test('Q-T69 ④ PRF-137 시작 파일 start()도 같은 규칙으로 좌석 Redis에 닿기 전에 멈춘다: 운영에서 주소 없음, 주소와 정적 묶음을 함께 둠', async () => {
    // 시작 파일은 시험 조립과 따로 본다(계획 §11). 발급자·좌석맵 폴더는 일부러 주지 않는다: 묶음 규칙보다 뒤에서 멈추면 그 문구가 묶음 이름을 담지 않아 이 시험이 실패한다
    const { start } = await import('../src/start.js');
    const base = { PEAKET_SEAT_REDIS_URL: 'redis://127.0.0.1:1' };
    const cases: [string, Record<string, string>][] = [
      ['prod 정적만', { ...base, PEAKET_ENV: 'prod', [STATIC_ENV]: STATIC }],
      ['demo 정적만', { ...base, PEAKET_ENV: 'demo', [STATIC_ENV]: STATIC }],
      ['ci 둘 다', { ...base, PEAKET_ENV: 'ci', [URL_ENV]: URL, [STATIC_ENV]: STATIC }],
      ['prod 둘 다', { ...base, PEAKET_ENV: 'prod', [URL_ENV]: URL, [STATIC_ENV]: STATIC }],
    ];
    for (const [label, env] of cases) await expect(start({ env }), label).rejects.toThrow(/PEAKET_ADMISSION_JWKS/);
  }, 60_000);
});
