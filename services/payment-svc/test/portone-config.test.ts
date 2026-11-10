// 포트원 어댑터 설정과 운영 조립의 글 검사(BUILD_ORDER HOT-140, docs/features/payment.md §2.1 '포트원 어댑터의 첫 구현').
// 비밀 값은 실행마다 만든다. 값은 저장소에 없다([ASVS v5.0.0-13.3.1]).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { assertPgAdapters, loadPortoneGatewayConfig } from '../src/config.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const code = (file: string): string =>
  readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');

const secretOf = (prefix = 'portone_'): string => `${prefix}${randomBytes(16).toString('hex')}`;
const OFFICIAL = 'https://api.portone.io';
const SIM_URL = 'http://pg-simulator:8790';
const webhook = `whsec_${randomBytes(32).toString('base64')}`;

const envOf = (peaketEnv: string | undefined, secret: string | undefined, over: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...(peaketEnv === undefined ? {} : { PEAKET_ENV: peaketEnv }),
  ...(secret === undefined ? {} : { PEAKET_PG_PORTONE_SECRET: secret }),
  PEAKET_PG_PORTONE_STORE_ID: 'store-1',
  PEAKET_PG_PORTONE_CHANNEL_KEY: 'channel-1',
  PEAKET_PG_PORTONE_WEBHOOK_SECRET: webhook,
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

describe('loadPortoneGatewayConfig', () => {
  test('P-T16_다 없으면 포트원 어댑터를 켜지 않는다', () => {
    expect(loadPortoneGatewayConfig({ PEAKET_ENV: 'prod' })).toBeUndefined();
    expect(loadPortoneGatewayConfig({ PEAKET_ENV: 'prod', PEAKET_PG_PORTONE_URL: OFFICIAL, PEAKET_PG_PORTONE_SECRET: ' ' })).toBeUndefined();
  });

  test('P-T16_주소 기본값은 포트원 공식 주소다', () => {
    const secret = secretOf();
    expect(loadPortoneGatewayConfig(envOf('prod', secret))).toEqual({ baseUrl: OFFICIAL, secret, storeId: 'store-1', channelKey: 'channel-1', webhookSecrets: [webhook], isTest: false });
  });

  test('P-T16_비밀 값 앞뒤 공백은 지운다', () => {
    const secret = secretOf();
    expect(loadPortoneGatewayConfig(envOf('prod', `${secret}\n`))?.secret).toBe(secret);
  });

  test.each([
    ['local', true],
    ['ci', true],
    ['demo', true],
    ['staging', true],
    ['prod', false],
    [undefined, false],
    ['unknown-env', false],
  ])('P-T16_PEAKET_ENV=%s의 시험 표시는 %s다', (env, isTest) => {
    expect(loadPortoneGatewayConfig(envOf(env, secretOf()))?.isTest).toBe(isTest);
  });

  test('P-T16_옛 웹훅 시크릿이 있으면 둘 다 싣는다(무중단 교체)', () => {
    const previous = `whsec_${randomBytes(32).toString('base64')}`;
    expect(loadPortoneGatewayConfig(envOf('prod', secretOf(), { PEAKET_PG_PORTONE_WEBHOOK_SECRET_PREVIOUS: previous }))?.webhookSecrets).toEqual([webhook, previous]);
  });

  test.each(['PEAKET_PG_PORTONE_SECRET', 'PEAKET_PG_PORTONE_STORE_ID', 'PEAKET_PG_PORTONE_CHANNEL_KEY', 'PEAKET_PG_PORTONE_WEBHOOK_SECRET'])('P-T16_%s 하나만 없으면 시작하지 않는다 [ASVS v5.0.0-16.5.3]', (name) => {
    const env = envOf('prod', secretOf());
    delete env[name];
    expect(() => loadPortoneGatewayConfig(env)).toThrow(new RegExp(name));
  });

  test.each(['PEAKET_PG_PORTONE_SECRET', 'PEAKET_PG_PORTONE_STORE_ID', 'PEAKET_PG_PORTONE_CHANNEL_KEY', 'PEAKET_PG_PORTONE_WEBHOOK_SECRET'])('P-T16_%s 하나만 없어 시작하지 못할 때 글에 나머지 비밀 값이 없다 [ASVS v5.0.0-16.2.5]', (name) => {
    const secret = secretOf();
    const env = envOf('prod', secret);
    delete env[name];
    const message = messageOf(() => loadPortoneGatewayConfig(env));
    expect(message).toMatch(new RegExp(name));
    expect(message).not.toContain(secret);
    expect(message).not.toContain(webhook);
  });

  test.each(['local', 'ci', 'demo', 'staging'])('P-T16_PEAKET_ENV=%s는 시뮬레이터를 가리킨 sim_sk_ 시크릿을 받는다 [ASVS v5.0.0-13.2.3]', (env) => {
    const secret = secretOf('sim_sk_');
    expect(loadPortoneGatewayConfig(envOf(env, secret, { PEAKET_PG_PORTONE_URL: SIM_URL }))).toMatchObject({ baseUrl: SIM_URL, secret, isTest: true });
  });

  test.each(['prod', undefined, 'unknown-env'])('P-T16_운영(PEAKET_ENV=%s)에 sim_sk_ 시크릿이면 시작하지 않고 글에 값이 없다 [ASVS v5.0.0-13.2.3] [ASVS v5.0.0-16.2.5]', (env) => {
    const secret = secretOf('sim_sk_');
    const message = messageOf(() => loadPortoneGatewayConfig(envOf(env, secret, { PEAKET_PG_PORTONE_URL: SIM_URL })));
    expect(message).toMatch(/PEAKET_PG_PORTONE_SECRET/);
    expect(message).not.toContain(secret);
  });

  test('P-T16_sim_sk_ 시크릿으로 포트원 공식 주소를 가리키면 시작하지 않는다 [ASVS v5.0.0-13.2.3]', () => {
    const secret = secretOf('sim_sk_');
    const message = messageOf(() => loadPortoneGatewayConfig(envOf('staging', secret)));
    expect(message).toMatch(/PEAKET_PG_PORTONE_URL/);
    expect(message).not.toContain(secret);
  });

  test.each(['prod', 'staging'])('P-T16_PEAKET_ENV=%s에 시뮬레이터용이 아닌 시크릿으로 https가 아닌 주소를 가리키면 시작하지 않는다 [ASVS v5.0.0-12.3.1] [ASVS v5.0.0-16.2.5]', (env) => {
    const secret = secretOf();
    const message = messageOf(() => loadPortoneGatewayConfig(envOf(env, secret, { PEAKET_PG_PORTONE_URL: 'http://api.portone.io' })));
    expect(message).toMatch(/https/);
    expect(message).not.toContain(secret);
  });

  test.each(['https://pg.example', 'https://api.portone.io.evil.example', 'https://api.portone.io:8443', 'https://portone.io'])('P-T16_시뮬레이터용이 아닌 시크릿으로 %s를 가리키면 시크릿이 그 호스트로 나가지 않게 시작하지 않는다 [ASVS v5.0.0-13.2.4] [ASVS v5.0.0-13.2.5] [ASVS v5.0.0-16.2.5]', (url) => {
    const secret = secretOf();
    const message = messageOf(() => loadPortoneGatewayConfig(envOf('prod', secret, { PEAKET_PG_PORTONE_URL: url })));
    expect(message).toMatch(/PEAKET_PG_PORTONE_URL/);
    expect(message).toMatch(/공식/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(url);
  });

  test.each([OFFICIAL, `${OFFICIAL}/`, 'https://API.portone.io', 'https://api.portone.io:443'])('P-T16_시뮬레이터용이 아닌 시크릿은 공식 호스트 %s를 받는다', (url) => {
    expect(loadPortoneGatewayConfig(envOf('prod', secretOf(), { PEAKET_PG_PORTONE_URL: url }))?.baseUrl).toBe(url);
  });

  test.each([
    ['URL이 아님', 'not a url'],
    ['http(s)가 아님', 'ftp://pg.example'],
    ['쿼리가 있음', 'https://pg.example/?a=1'],
    ['조각이 있음', 'https://pg.example/#a'],
    ['사용자 정보가 있음', 'https://user:s3cret-value@pg.example'],
  ])('P-T16_주소가 %s이면 시작하지 않고 글에 그 값이 없다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.5.3]', (_n, value) => {
    const message = messageOf(() => loadPortoneGatewayConfig(envOf('staging', secretOf(), { PEAKET_PG_PORTONE_URL: value })));
    expect(message).toMatch(/PEAKET_PG_PORTONE_URL/);
    expect(message).not.toContain(value);
  });
});

describe('assertPgAdapters: 포트원을 더해도 조건은 그대로다', () => {
  test.each(['demo', 'staging', 'prod', undefined])('P-T16_PEAKET_ENV=%s는 토스 어댑터가 있어야 시작한다(포트원은 세지 않는다) [ASVS v5.0.0-16.5.3]', (env) => {
    expect(() => assertPgAdapters(env === undefined ? {} : { PEAKET_ENV: env }, { simulator: false, toss: false })).toThrow(/PEAKET_PG_TOSS_SECRET_KEY/);
  });
});

describe('운영 조립: 포트원 어댑터(글 검사)', () => {
  const main = (): string => code('start.ts');
  const shutdown = (): string => main().slice(main().indexOf('const shutdown = (): Promise<void> => {'));

  test('P-T16_main.ts는 포트원 설정을 읽고 등록부에 어댑터를 듣기 전에 넣는다 [ASVS v5.0.0-16.5.3]', () => {
    const m = main();
    expect(m).toMatch(/\bloadPortoneGatewayConfig\(env\)/);
    expect(m.indexOf('new PortoneGateway('), '어댑터 < listen').toBeGreaterThan(-1);
    expect(m.indexOf('new PortoneGateway('), '어댑터 < listen').toBeLessThan(m.indexOf('await service.listen()'));
  });

  test('P-T16_포트원 어댑터는 승인·조회 연결 묶음을 따로 받고 종료 때 닫는다 [ASVS v5.0.0-13.2.6]', () => {
    const m = main();
    expect(m).toMatch(/connections:\s*perPodBulkhead\(PG_CHANNEL_BULKHEAD\.PORTONE,\s*\w+\.podCount\)/);
    const call = /new PortoneGateway\(\{([\s\S]*?)\}\)/.exec(m)![1]!;
    expect(call).toMatch(/\bfetch:\s*portoneHttp!?\.fetch\b/);
    expect(call).toMatch(/\bqueryFetch:\s*portoneQueryHttp!?\.fetch\b/);
    expect(shutdown()).toMatch(/portoneHttp\??\.close\(\)/);
    expect(shutdown()).toMatch(/portoneQueryHttp\??\.close\(\)/);
  });

  test('P-T16_v0 공개 면은 포트원 어댑터를 끌고 가지 않는다', () => {
    expect(code('modules/payment/index.ts')).not.toMatch(/portone-gateway|PortoneGateway/);
  });
});
