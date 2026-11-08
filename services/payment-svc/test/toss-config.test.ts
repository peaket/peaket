// 토스 어댑터 설정과 어댑터 시작 조건, 운영 조립의 글 검사(BUILD_ORDER PRF-184, docs/features/payment.md §2.1 '토스 어댑터의 첫 구현').
// 키 값은 실행마다 만든다. 접두사만 글로 두고 값은 저장소에 없다([ASVS v5.0.0-13.3.1]).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { assertPgAdapters, loadTossGatewayConfig } from '../src/config.js';
import { TossPaymentGateway } from '../src/modules/payment/adapters/pg/toss-gateway.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const code = (file: string): string =>
  readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');

const keyOf = (prefix: string): string => `${prefix}${randomBytes(16).toString('hex')}`;
const OFFICIAL = 'https://api.tosspayments.com';
const SIM_URL = 'http://pg-simulator:8790';

/** 시크릿 키와 환경·종류가 짝인 공개 키(sk↔ck, gsk↔gck). 접두사만 맞춘 값이다 */
const clientFor = (secret: string): string => {
  const [env, kind] = secret.split('_');
  return `${env}_${kind === 'gsk' ? 'gck' : 'ck'}_public`;
};

const envOf = (peaketEnv: string | undefined, secret: string | undefined, over: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...(peaketEnv === undefined ? {} : { PEAKET_ENV: peaketEnv }),
  ...(secret === undefined ? {} : { PEAKET_PG_TOSS_SECRET_KEY: secret }),
  PEAKET_PG_TOSS_CLIENT_KEY: secret === undefined ? 'test_ck_public' : clientFor(secret),
  ...over,
});
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return String(e);
  }
  throw new Error('시작 실패를 기대했는데 통과했다');
};

describe('loadTossGatewayConfig', () => {
  test('P-T16_두 키가 다 없으면 토스 어댑터를 켜지 않는다', () => {
    expect(loadTossGatewayConfig({ PEAKET_ENV: 'prod' })).toBeUndefined();
    expect(loadTossGatewayConfig({ PEAKET_ENV: 'prod', PEAKET_PG_TOSS_URL: OFFICIAL, PEAKET_PG_TOSS_SECRET_KEY: ' ', PEAKET_PG_TOSS_CLIENT_KEY: '' })).toBeUndefined();
  });

  test('P-T16_주소 기본값은 토스 공식 주소다', () => {
    const secret = keyOf('test_sk_');
    expect(loadTossGatewayConfig(envOf('staging', secret))).toEqual({ baseUrl: OFFICIAL, secretKey: secret, clientKey: clientFor(secret), callsPerSecond: 1 });
  });

  test('P-T16_키 앞뒤 공백은 지운다(비밀 저장소 값의 줄바꿈)', () => {
    const secret = keyOf('test_sk_');
    expect(loadTossGatewayConfig(envOf('ci', `${secret}\n`))?.secretKey).toBe(secret);
  });

  test.each([
    ['PEAKET_PG_TOSS_SECRET_KEY', { PEAKET_ENV: 'staging', PEAKET_PG_TOSS_CLIENT_KEY: 'test_ck_public' }],
    ['PEAKET_PG_TOSS_CLIENT_KEY', { PEAKET_ENV: 'staging', PEAKET_PG_TOSS_SECRET_KEY: keyOf('test_sk_') }],
  ])('P-T16_%s 하나만 없으면 시작하지 않는다 [ASVS v5.0.0-16.5.3]', (name, env) => {
    expect(() => loadTossGatewayConfig(env)).toThrow(new RegExp(name));
  });

  test.each([
    ['local', 'test_sk_'],
    ['ci', 'test_sk_'],
    ['demo', 'test_sk_'],
    ['staging', 'test_sk_'],
    ['prod', 'live_sk_'],
    [undefined, 'live_sk_'],
  ])('P-T16_PEAKET_ENV=%s는 %s 키를 받는다 [ASVS v5.0.0-13.2.3]', (env, prefix) => {
    const secret = keyOf(prefix);
    expect(loadTossGatewayConfig(envOf(env, secret))?.secretKey).toBe(secret);
  });

  test.each(['local', 'ci', 'demo', 'staging'])('P-T16_PEAKET_ENV=%s는 시뮬레이터를 가리킨 sim_sk_ 키를 받는다 [ASVS v5.0.0-13.2.3]', (env) => {
    const secret = keyOf('sim_sk_');
    expect(loadTossGatewayConfig(envOf(env, secret, { PEAKET_PG_TOSS_URL: SIM_URL }))).toEqual({ baseUrl: SIM_URL, secretKey: secret, clientKey: clientFor(secret) });
  });

  test.each([
    ['prod', 'test_sk_'],
    ['prod', 'sim_sk_'],
    [undefined, 'test_sk_'],
    ['unknown-env', 'test_sk_'],
    ['local', 'live_sk_'],
    ['ci', 'live_sk_'],
    ['demo', 'live_sk_'],
    ['staging', 'live_sk_'],
    ['staging', 'wrong_sk_'],
    ['prod', 'wrong_sk_'],
  ])('P-T16_PEAKET_ENV=%s에 %s 키면 시작하지 않고 오류 글에 키 값이 없다 [ASVS v5.0.0-13.2.3] [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.5.3]', (env, prefix) => {
    const secret = keyOf(prefix);
    const message = messageOf(() => loadTossGatewayConfig(envOf(env, secret, { PEAKET_PG_TOSS_URL: 'https://pg.example' })));
    expect(message).toMatch(/PEAKET_PG_TOSS_SECRET_KEY/);
    expect(message).not.toContain(secret);
  });

  test('P-T16_sim_sk_ 키로 토스 공식 주소를 가리키면 시작하지 않는다 [ASVS v5.0.0-13.2.3]', () => {
    const secret = keyOf('sim_sk_');
    const message = messageOf(() => loadTossGatewayConfig(envOf('staging', secret)));
    expect(message).toMatch(/PEAKET_PG_TOSS_URL/);
    expect(message).not.toContain(secret);
  });

  test('P-T16_sim_sk_가 아닌 키로 https가 아닌 주소를 가리키면 시작하지 않는다 [ASVS v5.0.0-12.3.1]', () => {
    expect(() => loadTossGatewayConfig(envOf('staging', keyOf('test_sk_'), { PEAKET_PG_TOSS_URL: 'http://api.tosspayments.com' }))).toThrow(/https/);
    expect(() => loadTossGatewayConfig(envOf('prod', keyOf('live_sk_'), { PEAKET_PG_TOSS_URL: 'http://api.tosspayments.com' }))).toThrow(/https/);
  });

  test.each([
    ['staging', 'test_sk_'],
    ['prod', 'live_sk_'],
  ])('P-T16_PEAKET_ENV=%s에 %s 키로 https가 아닌 주소를 가리켜 시작하지 못해도 오류 글에 키 값이 없다 [ASVS v5.0.0-16.2.5]', (env, prefix) => {
    const secret = keyOf(prefix);
    const message = messageOf(() => loadTossGatewayConfig(envOf(env, secret, { PEAKET_PG_TOSS_URL: 'http://pg.example' })));
    expect(message).toMatch(/https/);
    expect(message).not.toContain(secret);
  });

  test.each([
    ['URL이 아님', 'not a url'],
    ['http(s)가 아님', 'ftp://pg.example'],
    ['쿼리가 있음', 'https://pg.example/?a=1'],
    ['조각이 있음', 'https://pg.example/#a'],
    ['사용자 정보가 있음', 'https://user:s3cret-value@pg.example'],
  ])('P-T16_주소가 %s이면 시작하지 않고 글에 그 값이 없다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.5.3]', (_n, value) => {
    const message = messageOf(() => loadTossGatewayConfig(envOf('staging', keyOf('test_sk_'), { PEAKET_PG_TOSS_URL: value })));
    expect(message).toMatch(/PEAKET_PG_TOSS_URL/);
    expect(message).not.toContain(value);
  });
});

describe('P-T16 리뷰 고침(BUILD_ORDER PRF-184, 코드 리뷰): 토스 키와 주소', () => {
  test.each([
    ['local', 'test_gsk_'],
    ['ci', 'test_gsk_'],
    ['demo', 'test_gsk_'],
    ['staging', 'test_gsk_'],
    ['prod', 'live_gsk_'],
    [undefined, 'live_gsk_'],
  ])('P-T16_리뷰 고침 H1: PEAKET_ENV=%s는 주문서형 키 %s를 받는다 [ASVS v5.0.0-13.2.3]', (env, prefix) => {
    const secret = keyOf(prefix);
    expect(loadTossGatewayConfig(envOf(env, secret))?.secretKey).toBe(secret);
  });

  test.each([
    ['prod', 'test_gsk_'],
    [undefined, 'test_gsk_'],
    ['staging', 'live_gsk_'],
    ['local', 'live_gsk_'],
  ])('P-T16_리뷰 고침 H1: PEAKET_ENV=%s에 주문서형 키 %s면 시작하지 않고 오류 글에 키 값이 없다 [ASVS v5.0.0-13.2.3] [ASVS v5.0.0-16.2.5]', (env, prefix) => {
    const secret = keyOf(prefix);
    const message = messageOf(() => loadTossGatewayConfig(envOf(env, secret)));
    expect(message).toMatch(/PEAKET_PG_TOSS_SECRET_KEY/);
    expect(message).not.toContain(secret);
  });

  test.each([
    ['staging', 'test_sk_', 'test_ck_'],
    ['staging', 'test_gsk_', 'test_gck_'],
    ['prod', 'live_sk_', 'live_ck_'],
    ['prod', 'live_gsk_', 'live_gck_'],
  ])('P-T16_리뷰 고침 H3: PEAKET_ENV=%s의 %s 시크릿은 %s 공개 키와 짝이다 [ASVS v5.0.0-13.2.3]', (env, secretPrefix, clientPrefix) => {
    const clientKey = keyOf(clientPrefix);
    expect(loadTossGatewayConfig(envOf(env, keyOf(secretPrefix), { PEAKET_PG_TOSS_CLIENT_KEY: clientKey }))?.clientKey).toBe(clientKey);
  });

  test('P-T16_리뷰 고침 H3: 시뮬레이터용 시크릿은 sim_ck_ 공개 키와 짝이다 [ASVS v5.0.0-13.2.3]', () => {
    const clientKey = keyOf('sim_ck_');
    expect(loadTossGatewayConfig(envOf('ci', keyOf('sim_sk_'), { PEAKET_PG_TOSS_URL: SIM_URL, PEAKET_PG_TOSS_CLIENT_KEY: clientKey }))?.clientKey).toBe(clientKey);
  });

  test.each([
    ['환경이 다름(시험 시크릿 + 운영 공개 키)', 'staging', 'test_sk_', 'live_ck_'],
    ['환경이 다름(운영 시크릿 + 시험 공개 키)', 'prod', 'live_sk_', 'test_ck_'],
    ['종류가 다름(sk + gck)', 'staging', 'test_sk_', 'test_gck_'],
    ['종류가 다름(gsk + ck)', 'staging', 'test_gsk_', 'test_ck_'],
    ['운영의 종류가 다름(gsk + ck)', 'prod', 'live_gsk_', 'live_ck_'],
    ['시크릿을 공개 키 칸에 넣음', 'staging', 'test_sk_', 'test_sk_'],
    ['운영 시크릿을 공개 키 칸에 넣음', 'prod', 'live_gsk_', 'live_gsk_'],
    ['접두사가 없음', 'staging', 'test_sk_', 'public'],
  ])('P-T16_리뷰 고침 H3: 공개 키가 %s이면 시작하지 않고 오류 글에 두 키 값이 없다 [ASVS v5.0.0-13.2.3] [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.5.3]', (_n, env, secretPrefix, clientPrefix) => {
    const secret = keyOf(secretPrefix);
    const clientKey = keyOf(clientPrefix);
    const message = messageOf(() => loadTossGatewayConfig(envOf(env, secret, { PEAKET_PG_TOSS_CLIENT_KEY: clientKey })));
    expect(message).toMatch(/PEAKET_PG_TOSS_CLIENT_KEY/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(clientKey);
  });

  test.each([
    ['staging', 'test_sk_', 'https://pg.example'],
    ['staging', 'test_gsk_', 'https://api.tosspayments.com.evil.example'],
    ['prod', 'live_sk_', 'https://pg.example'],
    ['prod', 'live_gsk_', 'https://api.tosspayments.com:8443'],
    ['prod', 'live_sk_', 'https://tosspayments.com'],
  ])('P-T16_리뷰 고침 M5: PEAKET_ENV=%s의 %s 키로 %s를 가리키면 키가 그 호스트로 나가지 않게 시작하지 않는다 [ASVS v5.0.0-13.2.4] [ASVS v5.0.0-13.2.5] [ASVS v5.0.0-16.2.5]', (env, prefix, url) => {
    const secret = keyOf(prefix);
    const message = messageOf(() => loadTossGatewayConfig(envOf(env, secret, { PEAKET_PG_TOSS_URL: url })));
    expect(message).toMatch(/PEAKET_PG_TOSS_URL/);
    expect(message).toMatch(/공식/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(url);
  });

  test.each([OFFICIAL, `${OFFICIAL}/`, 'https://API.tosspayments.com', 'https://api.tosspayments.com:443'])('P-T16_리뷰 고침 M5: 시뮬레이터용이 아닌 키는 공식 호스트 %s를 받는다', (url) => {
    expect(loadTossGatewayConfig(envOf('prod', keyOf('live_sk_'), { PEAKET_PG_TOSS_URL: url }))?.baseUrl).toBe(url);
  });

  test.each(['test_sk_', 'test_gsk_'])('P-T16_리뷰 고침 M6: 시험 키 %s의 호출 상한은 기본 초당 1 [가정]이다(시험 환경 분당 100건) [ASVS v5.0.0-2.3.2]', (prefix) => {
    const config = loadTossGatewayConfig(envOf('staging', keyOf(prefix)))!;
    expect(config.callsPerSecond).toBe(1);
    expect(new TossPaymentGateway(config).capabilities().callsPerSecond).toBe(1);
  });

  test.each(['live_sk_', 'live_gsk_'])('P-T16_리뷰 고침 M6: 운영 키 %s의 호출 상한은 기본 초당 300 [가정]이다 [ASVS v5.0.0-2.3.2]', (prefix) => {
    expect(new TossPaymentGateway(loadTossGatewayConfig(envOf('prod', keyOf(prefix)))!).capabilities().callsPerSecond).toBe(300);
  });

  test.each([
    ['staging', 'test_sk_', '50', 50],
    ['staging', 'test_gsk_', '1.5', 1.5],
    ['prod', 'live_sk_', '120', 120],
    ['prod', 'live_sk_', ' 80 ', 80],
  ])('P-T16_리뷰 고침 M6: PEAKET_ENV=%s의 %s 키는 PEAKET_PG_TOSS_CALLS_PER_SECOND=%s를 쓴다 [ASVS v5.0.0-2.3.2]', (env, prefix, raw, want) => {
    expect(loadTossGatewayConfig(envOf(env, keyOf(prefix), { PEAKET_PG_TOSS_CALLS_PER_SECOND: raw }))?.callsPerSecond).toBe(want);
  });

  test.each(['0', '0.0', '-1', 'abc', '1e3', 'Infinity', '10rps'])('P-T16_리뷰 고침 M6: PEAKET_PG_TOSS_CALLS_PER_SECOND=%s는 양수가 아니라 시작하지 않는다 [ASVS v5.0.0-16.5.3]', (raw) => {
    expect(() => loadTossGatewayConfig(envOf('staging', keyOf('test_sk_'), { PEAKET_PG_TOSS_CALLS_PER_SECOND: raw }))).toThrow(/PEAKET_PG_TOSS_CALLS_PER_SECOND/);
  });

  test('P-T16_리뷰 고침 M6: 빈 PEAKET_PG_TOSS_CALLS_PER_SECOND는 없는 것과 같다', () => {
    expect(loadTossGatewayConfig(envOf('staging', keyOf('test_sk_'), { PEAKET_PG_TOSS_CALLS_PER_SECOND: ' ' }))?.callsPerSecond).toBe(1);
  });
});

describe('assertPgAdapters', () => {
  test.each(['local', 'ci'])('P-T16_PEAKET_ENV=%s는 어댑터가 없어도 켠다', (env) => {
    expect(() => assertPgAdapters({ PEAKET_ENV: env }, { simulator: false, toss: false })).not.toThrow();
    expect(() => assertPgAdapters({ PEAKET_ENV: env }, { simulator: true, toss: false })).not.toThrow();
  });

  test.each(['demo', 'staging', 'prod', undefined])('P-T16_PEAKET_ENV=%s는 어댑터가 없으면 시작하지 않는다 [ASVS v5.0.0-16.5.3]', (env) => {
    expect(() => assertPgAdapters(env === undefined ? {} : { PEAKET_ENV: env }, { simulator: false, toss: false })).toThrow(/PEAKET_PG_TOSS_SECRET_KEY/);
  });

  test.each(['demo', 'staging'])('P-T16_PEAKET_ENV=%s는 시뮬레이터만으로는 시작하지 않고, 토스 어댑터와 함께면 켠다(부하 시험·전환 훈련) [ASVS v5.0.0-16.5.3]', (env) => {
    expect(() => assertPgAdapters({ PEAKET_ENV: env }, { simulator: true, toss: false })).toThrow(/PEAKET_PG_TOSS_SECRET_KEY/);
    expect(() => assertPgAdapters({ PEAKET_ENV: env }, { simulator: true, toss: true })).not.toThrow();
  });

  test.each(['prod', undefined])('P-T16_운영(PEAKET_ENV=%s)에 시뮬레이터 어댑터가 켜지면 시작하지 않는다 [ASVS v5.0.0-16.5.3]', (env) => {
    const e = env === undefined ? {} : { PEAKET_ENV: env };
    expect(() => assertPgAdapters(e, { simulator: true, toss: true })).toThrow(/PEAKET_PG_SIM_URL/);
    expect(() => assertPgAdapters(e, { simulator: false, toss: true })).not.toThrow();
  });
});

describe('운영 조립: 토스 어댑터(글 검사)', () => {
  const main = (): string => code('main.ts');
  const shutdown = (): string => main().slice(main().indexOf("process.once('SIGTERM'"));

  test('P-T16_main.ts는 토스 설정을 읽고 시작 조건을 듣기 전에 본다 [ASVS v5.0.0-16.5.3]', () => {
    const m = main();
    expect(m).toMatch(/\bloadTossGatewayConfig\(process\.env\)/);
    expect(m).toMatch(/\bassertPgAdapters\(process\.env,/);
    expect(m.indexOf('assertPgAdapters(process.env'), '시작 조건 < listen').toBeLessThan(m.indexOf('await service.listen()'));
    expect(m.indexOf('new TossPaymentGateway('), '어댑터 < listen').toBeLessThan(m.indexOf('await service.listen()'));
  });

  test('P-T16_토스 어댑터는 승인·조회 연결 묶음을 따로 받고 종료 때 닫는다 [ASVS v5.0.0-13.2.6]', () => {
    const m = main();
    expect(m).toMatch(/connections:\s*perPodBulkhead\(PG_CHANNEL_BULKHEAD\.TOSS,\s*\w+\.podCount\)/);
    const call = /new TossPaymentGateway\(\{([\s\S]*?)\}\)/.exec(m)![1]!;
    expect(call).toMatch(/\bfetch:\s*tossHttp!?\.fetch\b/);
    expect(call).toMatch(/\bqueryFetch:\s*tossQueryHttp!?\.fetch\b/);
    expect(shutdown()).toMatch(/tossHttp\??\.close\(\)/);
    expect(shutdown()).toMatch(/tossQueryHttp\??\.close\(\)/);
  });

  test('P-T16_v0 공개 면은 토스 어댑터와 서버 전용 연결 묶음을 끌고 가지 않는다', () => {
    expect(code('modules/payment/index.ts')).not.toMatch(/toss-gateway|TossPaymentGateway|pg-http|undici/);
    expect(code('modules/payment/adapters/pg/toss-shaped.ts')).not.toMatch(/from '(undici|\.\/pg-http\.js)'/);
    expect(code('modules/payment/adapters/pg/simulator-gateway.ts')).not.toMatch(/from '(undici|\.\/pg-http\.js|\.\/toss-gateway\.js)'/);
  });
});
