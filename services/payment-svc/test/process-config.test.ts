// payment-svc 프로세스 설정(loadPaymentServiceConfig)과 운영 조립(main.ts·relay.ts·relay-app.ts)의 글 검사(BUILD_ORDER PRF-180, docs/features/payment.md §2 '프로세스'·'연결 풀', docs/verification.md §4.1).
// 조립은 빠뜨려도 형 오류가 나지 않는 곳만 글로 본다(purchase-svc payment-result-pull.test.ts의 '운영 조립'과 같은 방식). 실제로 띄워 보는 것은 test-int가 본다.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { DEFAULT_PAYMENT_GRPC_PORT, loadEntryPausePrometheusUrl, loadPaymentServiceConfig, loadPgCallGuardConfig, loadSimulatorGatewayConfig, PAYMENT_BATCH_POOL_MAX, PAYMENT_HOT_POOL_MAX } from '../src/config.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const URL_WITH_PASSWORD = 'postgres://payment_svc:hunter2@pgbouncer:6432/payment';

/** 주석을 뺀 소스(주석으로 막은 줄이나 설명 글이 통과하지 않게) */
const code = (file: string): string =>
  readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');

/** src 아래 모든 .ts 파일(상대 경로) */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith('.ts') ? [relative(SRC, full).split('\\').join('/')] : [];
  });
}

describe('loadPaymentServiceConfig', () => {
  test('PRF180_필수 값만 주면 기본값으로 채운다', () => {
    expect(loadPaymentServiceConfig({ PEAKET_DATABASE_URL: URL_WITH_PASSWORD })).toEqual({ databaseUrl: URL_WITH_PASSWORD, grpcHost: '0.0.0.0', grpcPort: DEFAULT_PAYMENT_GRPC_PORT });
    expect(DEFAULT_PAYMENT_GRPC_PORT).toBe(50051);
  });

  test('PRF180_주소와 포트를 환경 값으로 바꾼다', () => {
    expect(loadPaymentServiceConfig({ PEAKET_DATABASE_URL: URL_WITH_PASSWORD, PEAKET_GRPC_HOST: '127.0.0.1', PEAKET_GRPC_PORT: '6000' })).toEqual({ databaseUrl: URL_WITH_PASSWORD, grpcHost: '127.0.0.1', grpcPort: 6000 });
  });

  test.each([
    ['1', 1],
    ['65535', 65_535],
  ])('PRF180_포트 경계 %s를 받는다', (value, port) => {
    expect(loadPaymentServiceConfig({ PEAKET_DATABASE_URL: URL_WITH_PASSWORD, PEAKET_GRPC_PORT: value }).grpcPort).toBe(port);
  });

  test.each([
    ['없음', {}],
    ['빈 값', { PEAKET_DATABASE_URL: '' }],
  ])('PRF180_PEAKET_DATABASE_URL이 %s이면 시작하지 않는다', (_name, env) => {
    expect(() => loadPaymentServiceConfig(env)).toThrow(/PEAKET_DATABASE_URL/);
  });

  test.each(['0', '65536', '-1', 'abc', '1.5', '80abc'])('PRF180_PEAKET_GRPC_PORT가 %j이면 시작하지 않는다', (value) => {
    expect(() => loadPaymentServiceConfig({ PEAKET_DATABASE_URL: URL_WITH_PASSWORD, PEAKET_GRPC_PORT: value })).toThrow(/PEAKET_GRPC_PORT/);
  });

  test('PRF180_시작 실패 글에 DB 주소(비밀번호)를 싣지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    let message = '';
    try {
      loadPaymentServiceConfig({ PEAKET_DATABASE_URL: URL_WITH_PASSWORD, PEAKET_GRPC_PORT: 'abc' });
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/PEAKET_GRPC_PORT/);
    expect(message).not.toContain('hunter2');
  });

  test('PRF180_연결 풀 크기는 정본의 핫패스 16개·일반 4개다(합 20개, docs/verification.md §4.1)', () => {
    expect(PAYMENT_HOT_POOL_MAX).toBe(16);
    expect(PAYMENT_BATCH_POOL_MAX).toBe(4);
  });
});

describe('loadSimulatorGatewayConfig', () => {
  const SIM = { PEAKET_PG_SIM_URL: 'http://pg-simulator:8080', PEAKET_PG_SIM_SECRET_KEY: 'sim_sk_secret_value', PEAKET_PG_SIM_CLIENT_KEY: 'sim_ck_client' };

  test('PRF181_세 값을 주면 시뮬레이터 어댑터 설정을 돌려준다', () => {
    expect(loadSimulatorGatewayConfig({ PEAKET_ENV: 'staging', ...SIM })).toMatchObject({ baseUrl: SIM.PEAKET_PG_SIM_URL, secretKey: SIM.PEAKET_PG_SIM_SECRET_KEY, clientKey: SIM.PEAKET_PG_SIM_CLIENT_KEY });
  });

  test.each([
    ['local', {}],
    ['ci', {}],
    ['local', { PEAKET_PG_SIM_URL: '' }],
    ['ci', { PEAKET_PG_SIM_URL: '   ' }],
  ])('PRF181_주소가 없으면 PEAKET_ENV=%s만 어댑터 없이 켠다(%j) [ASVS v5.0.0-16.5.3]', (env, extra) => {
    expect(loadSimulatorGatewayConfig({ PEAKET_ENV: env, ...extra })).toBeUndefined();
  });

  test.each(['demo', 'staging', 'prod', undefined])('PRF181_리뷰 고침 M4: 주소가 없으면 PEAKET_ENV=%s에서도 읽는 함수는 어댑터 없음(undefined)을 돌려준다(시작 조건은 assertPgAdapters, BUILD_ORDER PRF-184) [ASVS v5.0.0-16.5.2]', (env) => {
    expect(loadSimulatorGatewayConfig(env === undefined ? {} : { PEAKET_ENV: env })).toBeUndefined();
  });

  test.each([
    ['URL이 아님', 'not a url'],
    ['http(s)가 아님', 'ftp://pg-simulator:8080'],
    ['쿼리가 있음', 'http://pg-simulator:8080/?a=1'],
    ['조각이 있음', 'http://pg-simulator:8080/#a'],
    ['사용자 정보가 있음', 'http://user:s3cret-value@pg-simulator:8080'],
  ])('PRF181_리뷰 고침 L10: 주소가 %s이면 시작하지 않고 글에 그 값을 싣지 않는다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.5.3]', (_name, value) => {
    let message = '';
    try {
      loadSimulatorGatewayConfig({ ...SIM, PEAKET_ENV: 'local', PEAKET_PG_SIM_URL: value });
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/PEAKET_PG_SIM_URL/);
    expect(message).not.toContain(value);
  });

  test.each(['http://pg-simulator:8080', 'https://pg-simulator.internal', 'http://127.0.0.1:9000/prefix'])('PRF181_리뷰 고침 L10: 주소 %s는 받는다', (value) => {
    expect(loadSimulatorGatewayConfig({ ...SIM, PEAKET_ENV: 'staging', PEAKET_PG_SIM_URL: value })?.baseUrl).toBe(value);
  });

  test.each([
    ['PEAKET_PG_SIM_SECRET_KEY', 'local'],
    ['PEAKET_PG_SIM_CLIENT_KEY', 'local'],
    ['PEAKET_PG_SIM_SECRET_KEY', 'prod'],
    ['PEAKET_PG_SIM_CLIENT_KEY', 'prod'],
  ])('PRF181_주소가 있는데 %s가 없으면 PEAKET_ENV=%s에서도 시작하지 않는다', (name, env) => {
    const { [name as keyof typeof SIM]: _missing, ...rest } = SIM;
    expect(() => loadSimulatorGatewayConfig({ PEAKET_ENV: env, ...rest })).toThrow(new RegExp(name));
  });

  test('PRF181_시작 실패 글에 비밀 키를 싣지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    let message = '';
    try {
      loadSimulatorGatewayConfig({ PEAKET_ENV: 'prod', PEAKET_PG_SIM_URL: SIM.PEAKET_PG_SIM_URL, PEAKET_PG_SIM_SECRET_KEY: SIM.PEAKET_PG_SIM_SECRET_KEY });
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/PEAKET_PG_SIM_CLIENT_KEY/);
    expect(message).not.toContain(SIM.PEAKET_PG_SIM_SECRET_KEY);
  });
});

describe('운영 조립: 승인 실행기(글 검사)', () => {
  const main = (): string => code('start.ts');
  const shutdown = (): string => main().slice(main().indexOf('const shutdown = (): Promise<void> => {'));
  const RUNNER_START = /\b\w*[Rr]unner\w*\??\.start\(\)/;
  const RUNNER_STOP = /\b\w*[Rr]unner\w*\??\.stop\(\)/;
  const poolName = (): string => /(?:const|let)\s+(\w+)\s*=\s*createDatabase\(confirmRunnerDatabaseOptions\(/.exec(main())?.[1] ?? '';

  test('PRF181_main.ts는 실행기 전용 풀을 confirmRunnerDatabaseOptions로 따로 만들어 DrizzleConfirmJobs에 넘긴다', () => {
    expect(main()).toMatch(/createDatabase\(confirmRunnerDatabaseOptions\(config\.databaseUrl\)\)/);
    expect(poolName()).not.toBe('');
    expect(main()).toMatch(new RegExp(`new DrizzleConfirmJobs\\(\\{[\\s\\S]*?\\bdatabase:\\s*${poolName()}\\b[\\s\\S]*?\\}\\)`));
  });

  test('PRF181_main.ts는 어댑터 등록부를 시뮬레이터 설정으로 조립한다(설정이 없으면 빈 등록부)', () => {
    expect(main()).toMatch(/\bloadSimulatorGatewayConfig\(env\)/);
    expect(main()).toMatch(/\bnew StaticPaymentGateways\(/);
    expect(main()).toMatch(/\bnew SimulatorPaymentGateway\(/);
  });

  test('PRF181_리뷰 고침 L10: 어댑터는 듣기 전에 만든다(잘못된 주소는 듣기 전에 시작 실패) [ASVS v5.0.0-16.5.3]', () => {
    const m = main();
    expect(m.indexOf('new SimulatorPaymentGateway(')).toBeGreaterThan(-1);
    expect(m.indexOf('new SimulatorPaymentGateway('), '어댑터 < listen').toBeLessThan(m.indexOf('await service.listen()'));
  });

  test('PRF181_리뷰 고침 M4: 어댑터가 하나도 없이 켜지면(local·ci만, BUILD_ORDER PRF-184) 시작 때 경고 한 줄을 낸다 [ASVS v5.0.0-16.3.4]', () => {
    const m = main();
    const warn = /if \(!simulator && !toss && !portone\) service\.logger\.warn\(\{ kind: 'payment-confirm-no-adapter' \}, '([^']*)'\)/.exec(m);
    expect(warn, '경고 한 줄').not.toBeNull();
    expect(warn![1]).not.toMatch(/local·ci일 때만/);
    expect(m.match(/service\.logger\.warn\(\{ kind: 'payment-confirm-no-adapter'/g)).toHaveLength(1);
  });

  test('P-T43_main.ts는 Lease로 뽑은 판정자를 메인 프로세스에서 켜고 끝낼 때 멈추며, Lease는 쿠버네티스가 없으면 혼자 리더다 [ASVS v5.0.0-16.5.3]', () => {
    const m = main();
    expect(m).toMatch(/env\.KUBERNETES_SERVICE_HOST \? inClusterLeaseApi\(ENTRY_PAUSE_LEASE_NAME, env\) : memoryLeaseApi\(\)/);
    expect(m).toMatch(/new LeaseElector\(/);
    const call = /new EntryPauseJudge\(\{([\s\S]*?)\}\)/.exec(m)![1]!;
    for (const key of ['store', 'inputs', 'gateways', 'guards', 'leader', 'podCount', 'clock', 'signals', 'log']) expect(call, key).toMatch(new RegExp(`\\b${key}\\b`));
    expect(m).toMatch(/new DrizzleEntryPause\(\{ database: batchDatabase \}\)/);
    expect(m).toMatch(/entryPauseJudge\.start\(\)/);
    expect(m).toMatch(/entryPauseElector\.start\(\)/);
    expect(/stop: \(\) => \[([\s\S]*?)\],\n/.exec(m)![1]).toMatch(/entryPauseJudge\.stop\(\)/);
    expect(m).toMatch(/PEAKET_PROMETHEUS_URL/);
    expect(m).toMatch(/NO_ENTRY_PAUSE_CLUSTER_INPUTS/);
  });

  test.each([['local'], ['ci']])('P-T43_리뷰 고침 M6: %s에서는 Prometheus 주소가 없어도 켠다(입력 없음)', (PEAKET_ENV) => {
    expect(loadEntryPausePrometheusUrl({ PEAKET_ENV })).toBeUndefined();
    expect(loadEntryPausePrometheusUrl({ PEAKET_ENV, PEAKET_PROMETHEUS_URL: '  ' })).toBeUndefined();
  });

  test.each([['staging'], ['demo'], ['prod'], [undefined]])('P-T43_리뷰 고침 M6: PEAKET_ENV=%s에서 Prometheus 주소가 없으면 시작을 실패시킨다 [ASVS v5.0.0-16.5.3]', (PEAKET_ENV) => {
    expect(() => loadEntryPausePrometheusUrl({ PEAKET_ENV })).toThrow(/PEAKET_PROMETHEUS_URL/);
  });

  test('P-T43_리뷰 고침 M6: 주소가 있으면 앞뒤 공백을 지워 돌려준다', () => {
    expect(loadEntryPausePrometheusUrl({ PEAKET_ENV: 'prod', PEAKET_PROMETHEUS_URL: ' http://prometheus:9090 ' })).toBe('http://prometheus:9090');
  });

  test('P-T43_리뷰 고침 M6: main.ts는 듣기 전에 Prometheus 주소를 읽어 시작을 실패시킨다', () => {
    const m = main();
    expect(m).toMatch(/loadEntryPausePrometheusUrl\(env\)/);
    expect(m.indexOf('loadEntryPausePrometheusUrl(env)')).toBeLessThan(m.indexOf('await service.listen()'));
    expect(m).not.toMatch(/\benv\.PEAKET_PROMETHEUS_URL/);
  });

  test('P-T43_리뷰 고침 M5·M8: main.ts는 캐시에 해제 감시를 잇고 Lease의 onChange로 판정자 표시를 낸다 [ASVS v5.0.0-16.5.3]', () => {
    const m = main();
    expect(/new CachedEntryPauseReader\(\{([\s\S]*?)\}\)/.exec(m)![1]).toMatch(/\bonLoaded\b/);
    expect(m).toMatch(/new EntryPauseReleaseWatcher\(/);
    expect(m).toMatch(/closeCircuit\(\)/);
    expect(/new LeaseElector\(\{([\s\S]*?)\}\)/.exec(m)![1]).toMatch(/onChange: \(leader\) => entryPauseSignals\.judgeLeader\(leader\)/);
  });

  test('P-T43_main.ts는 PrepareCheckout과 승인 실행기에 시험 재개의 받기·결과를 잇는다 [ASVS v5.0.0-2.3.2]', () => {
    const m = main();
    expect(/new PrepareCheckout\(\{([\s\S]*?)\}\)/.exec(m)![1]).toMatch(/\btrialSignals\b/);
    const runner = /new PaymentConfirmRunner\(\{([\s\S]*?)\}\)/.exec(m)![1]!;
    for (const key of ['trialResults', 'pauses', 'trialSignals']) expect(runner, key).toMatch(new RegExp(`\\b${key}\\b`));
  });

  test('PRF181_main.ts는 실행기에 포트 전부와 파드 이름을 넘긴다', () => {
    const at = main().indexOf('new PaymentConfirmRunner(');
    expect(at, 'new PaymentConfirmRunner').toBeGreaterThan(-1);
    const call = /new PaymentConfirmRunner\(\{([\s\S]*?)\}\)/.exec(main())![1]!;
    for (const key of ['jobs', 'gateways', 'log', 'signals', 'clock', 'podId', 'guards']) expect(call, key).toMatch(new RegExp(`\\b${key}\\b`));
  });

  test('PRF183_main.ts는 어댑터 등록부와 파드 수로 보호기 하나를 만들어 두 실행기에 함께 넘긴다(승인과 조회가 같은 버킷을 쓴다) [ASVS v5.0.0-2.3.2]', () => {
    const m = main();
    const call = /new PgCallGuards\(\{([\s\S]*?)\}\)/.exec(m)![1]!;
    for (const key of ['gateways', 'podCount', 'clock', 'signals', 'log']) expect(call, key).toMatch(new RegExp(`\\b${key}\\b`));
    expect(m.match(/new PgCallGuards\(/g)).toHaveLength(1);
    expect(/new PaymentConfirmRunner\(\{([\s\S]*?)\}\)/.exec(m)![1]).toMatch(/\bguards\b/);
    expect(/new PaymentUnknownResolver\(\{([\s\S]*?)\}\)/.exec(m)![1]).toMatch(/\bguards\b/);
    expect(m).toMatch(/\bpgCallGuardLog\(service\.logger\)/);
    expect(m).toMatch(/\bnew PromPgCallGuardSignals\(/);
  });

  test('PRF183_main.ts는 어댑터에 벌크헤드 이하의 연결 묶음을 주입하고 종료 때 닫는다 [ASVS v5.0.0-13.2.6]', () => {
    const m = main();
    expect(/createPgHttp\(\{([\s\S]*?)\}\)/.exec(m)![1]).toMatch(/connections:\s*perPodBulkhead\(PG_CHANNEL_BULKHEAD\.SIMULATOR,\s*\w+\.podCount\)/);
    expect(/new SimulatorPaymentGateway\(\{([\s\S]*?)\}\)/.exec(m)![1]).toMatch(/\bfetch:\s*\w+[?!]?\.fetch\b/);
    expect(shutdown()).toMatch(/pgHttp\??\.close\(\)/);
  });

  test('P-T40_리뷰 고침 H2: 파드 수는 듣기 전에 읽는다(local·ci 밖에서 비어 있으면 듣기 전에 시작 실패) [ASVS v5.0.0-16.5.3]', () => {
    const m = main();
    expect(m.indexOf('loadPgCallGuardConfig(env)'), '설정 읽기').toBeGreaterThan(-1);
    expect(m.indexOf('loadPgCallGuardConfig(env)'), '설정 읽기 < listen').toBeLessThan(m.indexOf('await service.listen()'));
    expect(m).not.toMatch(/warnPodCountMissing/);
  });

  test('P-T40_리뷰 고침 M4: main.ts는 조회 전용 연결 묶음(연결 16 [가정])을 따로 만들어 어댑터에 주고 종료 때 닫는다 [ASVS v5.0.0-13.2.6]', () => {
    const m = main();
    expect(m).toMatch(/createPgHttp\(\{\s*connections:\s*UNKNOWN_QUERY_CONCURRENCY\s*\}\)/);
    expect(/new SimulatorPaymentGateway\(\{([\s\S]*?)\}\)/.exec(m)![1]).toMatch(/\bqueryFetch:\s*\w+[?!]?\.fetch\b/);
    expect(shutdown()).toMatch(/pgQueryHttp\??\.close\(\)/);
  });

  test('PRF181_main.ts는 실행기 지표를 서비스 레지스트리에 붙이고 플랫폼 로거로 로그를 잇는다', () => {
    expect(main()).toMatch(/\bnew PromPaymentConfirmSignals\(/);
    expect([...main().matchAll(/\.register\(service\.metrics\.registry\)/g)]).toHaveLength(11);
    expect(main()).toMatch(/\bpaymentConfirmLog\(service\.logger\)/);
  });

  test('P-T50_main.ts는 라벨 키와 연결값 지표를 두 실행기에 넘기고 라벨 키 경고를 로그로 남긴다 [ASVS v5.0.0-16.5.2]', () => {
    const m = main();
    expect(m).toMatch(/PayRefKeyRing\.fromEnv\(env\)/);
    for (const name of ['PaymentConfirmRunner', 'PaymentUnknownResolver']) {
      const call = new RegExp(`new ${name}\\(\\{([\\s\\S]*?)\\}\\)`).exec(m)![1]!;
      expect(call, name).toMatch(/\bmethodRefs\b/);
      expect(call, name).toMatch(/\bmethodRefSignals\b/);
    }
    expect(m).toMatch(/methodRefSignals\.register\(service\.metrics\.registry\)/);
    expect(m).toMatch(/for \(const warning of methodRefWarnings\) service\.logger\.warn/);
  });

  test('PRF182_main.ts는 UNKNOWN 조회 실행기에 승인 실행기의 저장소(전용 풀)와 포트 전부를 넘기고 지표·로그를 잇는다', () => {
    const call = /new PaymentUnknownResolver\(\{([\s\S]*?)\}\)/.exec(main())![1]!;
    expect(call).toMatch(/\bqueries:\s*confirmJobs\b/);
    for (const key of ['gateways', 'log', 'signals', 'clock', 'guards']) expect(call, key).toMatch(new RegExp(`\\b${key}\\b`));
    expect(main()).toMatch(/\bnew PromPaymentUnknownSignals\(/);
    expect(main()).toMatch(/\bunknownSignals\.register\(service\.metrics\.registry\)/);
    expect(main()).toMatch(/\bpaymentUnknownLog\(service\.logger\)/);
  });

  test('PRF182_조립 차례: 듣기 시작한 뒤, 지표를 붙인 뒤에 UNKNOWN 조회 실행기를 켠다', () => {
    const m = main();
    const start = m.indexOf('unknownResolver.start()');
    expect(start, 'start').toBeGreaterThan(-1);
    expect(m.indexOf('new PaymentUnknownResolver('), '만들기 < 켜기').toBeLessThan(start);
    expect(m.indexOf('await service.listen()'), 'listen < 켜기').toBeLessThan(start);
    expect(m.indexOf('unknownSignals.register(service.metrics.registry)'), '지표 붙이기 < 켜기').toBeLessThan(start);
  });

  test('PRF182_SIGTERM: 준비 상태를 내린 뒤 UNKNOWN 조회 실행기를 멈추고, 그 뒤에 서비스와 풀을 닫는다 [ASVS v5.0.0-2.3.3]', () => {
    const s = shutdown();
    const stop = s.indexOf('unknownResolver.stop()');
    expect(s.indexOf("readiness.register('shutting-down')"), '준비 상태 내리기 < stop').toBeLessThan(stop);
    expect(stop, 'unknownResolver.stop').toBeGreaterThan(-1);
    expect(s.indexOf('service.close()'), 'stop < service.close').toBeGreaterThan(stop);
    expect(s.indexOf(`${poolName()}.close()`), 'stop < 풀 닫기').toBeGreaterThan(stop);
  });

  test('PRF181_조립 차례: 듣기 시작한 뒤, 지표를 붙인 뒤에 실행기를 켠다', () => {
    const m = main();
    const start = m.search(RUNNER_START);
    expect(start, '실행기 start').toBeGreaterThan(-1);
    expect(m.indexOf('new PaymentConfirmRunner('), '만들기 < 켜기').toBeLessThan(start);
    expect(m.indexOf('await service.listen()'), 'listen < 켜기').toBeLessThan(start);
    expect(m.lastIndexOf('.register(service.metrics.registry)', start), '지표 붙이기 < 켜기').toBeGreaterThan(-1);
    expect([...m.slice(0, start).matchAll(/\.register\(service\.metrics\.registry\)/g)], '지표 열하나 다 켜기 앞').toHaveLength(11);
  });

  test('PRF181_SIGTERM: 준비 상태를 내린 뒤 실행기를 멈추고(돌던 호출을 기다린다), 그 뒤에 서비스와 전용 풀을 닫는다 [ASVS v5.0.0-2.3.3]', () => {
    const s = shutdown();
    const down = s.indexOf("readiness.register('shutting-down')");
    const stop = s.search(RUNNER_STOP);
    const close = s.indexOf('service.close()');
    const pool = s.indexOf(`${poolName()}.close()`);
    expect(down, '준비 상태 내리기').toBeGreaterThan(-1);
    expect(stop, '실행기 stop').toBeGreaterThan(down);
    expect(close, 'stop < service.close').toBeGreaterThan(stop);
    expect(pool, 'stop < 전용 풀 닫기').toBeGreaterThan(stop);
  });

  test('P-T34 main.ts는 보호기의 낮춤을 표 맞추기에 잇고, 승인 실행기를 켜기 전에 표를 한 번 읽은 뒤 1초 맞추기를 켜며 멈출 때 기다린다', () => {
    const m = main();
    expect(/new PgCallGuards\(\{([\s\S]*?)\}\);/.exec(m)![1]).toMatch(/share:\s*\{\s*lowered:\s*\(e\)\s*=>\s*limitSync\?\.lowered\(e\)\s*\}/);
    expect(m).toMatch(/new PgChannelLimitSync\(\{ store: new DrizzlePgChannelLimit\(\{ database: batchDatabase \}\), guards,/);
    const refresh = m.indexOf('await limitSync.refresh();');
    expect(refresh, '시작 읽기').toBeGreaterThan(-1);
    expect(m.indexOf('limitSync.start();'), '읽은 뒤 맞추기').toBeGreaterThan(refresh);
    expect(m.search(RUNNER_START), '읽은 뒤 실행기').toBeGreaterThan(refresh);
    expect(shutdown()).toMatch(/limitSync!\.stop\(\)/);
    // 표 맞추기와 관측기는 실행기가 멈춘 뒤(drain)에 멈춘다: 마무리 중 받은 첫 429의 낮춤도 표에 쓴다(코드 리뷰 F5, 차례는 test/pg-channel-sync.test.ts)
    const stopList = /stop: \(\) => \[([\s\S]*?)\],\n/.exec(shutdown())![1]!;
    const drainList = /drain: \(\) => \[([\s\S]*?)\],\n/.exec(shutdown())![1]!;
    expect(stopList).toMatch(/confirmRunner\.stop\(\)/);
    expect(stopList).not.toMatch(/limitSync|channelObserver/);
    expect(drainList).toMatch(/limitSync!\.stop\(\)/);
    expect(drainList).toMatch(/channelObserver\?\.whenIdle\(\)/);
  });

  test('P-T46 ③ main.ts는 듣기 전에 포트원 채널의 하위 결제사 표를 읽고 플랫폼 기본값을 하위 결제사 규칙으로 검사한다 [ASVS v5.0.0-16.5.3]', () => {
    const m = main();
    const check = m.indexOf('assertPlatformSubProviders(checkoutConfig.defaults, portoneChannels);');
    expect(check).toBeGreaterThan(m.indexOf('const portoneChannels = loadPortoneChannelMap(env, portone);'));
    expect(check, '듣기 전').toBeLessThan(m.indexOf('await service.listen()'));
    expect(m).toMatch(/onChannel: \(c\) => channelObserver\?\.observe\(c\)/);
    expect(m).toMatch(/const fallbackExclusions = portoneChannels \? new PortoneFallbackExclusions\(\{ portone: portoneChannels, observations: channelObservations \}\) : undefined;/);
    // 결제창 준비와 정지 조회가 같은 빼기 읽기를 쓴다(코드 리뷰 F2)
    expect(/new PrepareCheckout\(\{([\s\S]*?)\}\)/.exec(m)![1]).toMatch(/\.\.\.\(fallbackExclusions \? \{ fallbackExclusions \}/);
    expect(/new GetNewPaymentPause\(\{([\s\S]*?)\}\)/.exec(m)![1]).toMatch(/\.\.\.\(fallbackExclusions \? \{ fallbackExclusions \}/);
  });
});

describe('운영 조립(글 검사)', () => {
  test('PRF180_뼈대 표시가 src에 남아 있지 않다', () => {
    const left = sourceFiles().filter((f) => readFileSync(join(SRC, f), 'utf8').includes('구현 전(뼈대)'));
    expect(left).toEqual([]);
  });

  /** createDatabase({ … }) 호출 몸통들 */
  const databaseCalls = (main: string): string[] => [...main.matchAll(/createDatabase\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]!);

  test('PRF180_main.ts는 핫패스 풀과 일반 풀을 따로 만든다(이름 payment-svc·payment-svc-batch, 크기는 config 상수)', () => {
    const calls = databaseCalls(code('start.ts'));
    expect(calls).toHaveLength(2);
    const batch = calls.find((c) => /-batch/.test(c));
    expect(batch, '일반 풀(payment-svc-batch)').toBeDefined();
    expect(batch).toMatch(/\bmax:\s*PAYMENT_BATCH_POOL_MAX\b/);
    expect(batch).not.toMatch(/profile:\s*'hot'/);
    const hot = calls.find((c) => c !== batch);
    expect(hot).toMatch(/profile:\s*'hot'/);
    expect(hot).toMatch(/\bmax:\s*PAYMENT_HOT_POOL_MAX\b/);
    expect(hot).toMatch(/applicationName:\s*(SERVICE|'payment-svc')\b/);
  });

  test('PRF180_main.ts는 저장소 하나에 두 풀을 다 넘긴다(결과 조회가 핫패스 풀을 쓰지 않게)', () => {
    expect(code('start.ts')).toMatch(/new DrizzlePaymentStore\(\{[\s\S]*?\bbatchDatabase\b[\s\S]*?\}\)/);
  });

  test('PRF180_main.ts는 지표를 서비스 레지스트리에 붙이고 PaymentService에 처리기를 묶는다', () => {
    const main = code('start.ts');
    expect(main).toMatch(/\bnew PromPaymentCommandSignals\(/);
    expect(main).toMatch(/\.register\(service\.metrics\.registry\)/);
    expect(main).toMatch(/\bstartGrpcServer\(/);
    expect(main).toMatch(/\bpaymentPackage\(\)/);
    expect(main).toMatch(/\bPaymentService\.service\b/);
    expect(main).toMatch(/\bpaymentServiceHandlers\(/);
    expect(main).toMatch(/\bloadPaymentServiceConfig\(env\)/);
  });

  test('PRF181_main.ts의 SIGTERM은 gRPC 포트 → 서비스 → DB 풀 넷(핫패스·일반·실행기 전용·웹훅 전용) 차례로 닫는다', () => {
    const main = code('start.ts');
    const at = main.indexOf('const shutdown = (): Promise<void> => {');
    expect(at, 'main.ts에 SIGTERM 처리가 있다').toBeGreaterThan(-1);
    const closes = [...main.slice(at).matchAll(/(\w+)\s*\??\.close\(\)/g)].map((m) => m[1]!);
    expect(closes.length, closes.join(',')).toBeGreaterThanOrEqual(5);
    expect(closes[0], closes.join(',')).toMatch(/grpc/i);
    expect(closes[1], closes.join(',')).toBe('service');
    expect(closes.slice(2).filter((n) => /database|db|pool/i.test(n)), closes.join(',')).toHaveLength(4);
  });

  test('P-T17_main.ts는 웹훅 전용 풀과 어댑터 등록부·지표·늦게 잇는 로그를 모듈에 넘긴다(시뮬레이터 허용은 환경 값으로)', () => {
    const main = code('start.ts');
    expect(main).toMatch(/createDatabase\(webhookDatabaseOptions\(config\.databaseUrl\)\)/);
    expect(main).toMatch(/new DrizzleWebhookStore\(\{ database: webhookDatabase \}\)/);
    expect(main).toMatch(/webhook: \{ store: new DrizzleWebhookStore\(\{ database: webhookDatabase \}\), gateways, log: lateWebhookLog, signals: webhookSignals, allowSimulator: webhookAcceptsSimulator\(env\) \}/);
    expect(main).toMatch(/webhookSignals\.register\(service\.metrics\.registry\)/);
    expect(main).toMatch(/webhookLog = paymentWebhookLog\(service\.logger, systemClock\)/);
  });

  test('P-T17_리뷰 고침 M4: main.ts는 앱 포트에 웹훅 요청 받기 시한을 건다 [ASVS v5.0.0-2.4.1]', () => {
    expect(code('start.ts')).toMatch(/requestTimeoutMs: WEBHOOK_REQUEST_TIMEOUT_MS/);
  });

  test('PRF180_relay.ts는 릴레이·정비 역할 연결과 Kafka 생산자로 startPaymentRelay를 띄우고 SIGTERM에 멈춘다', () => {
    const relay = code('relay.ts');
    expect(relay).toMatch(/\bloadOutboxRelayProcessConfig\(/);
    expect(relay).toMatch(/\boutboxDatabaseUrl\b/);
    expect(relay).toMatch(/\bmaintenanceDatabaseUrl\b/);
    expect(relay).toMatch(/\bkafkaOutboxPublisher\(/);
    expect(relay).toMatch(/\binClusterLeaseApi\(/);
    expect(relay).toMatch(/\bstartPaymentRelay\(/);
    expect(relay.indexOf('SIGTERM')).toBeGreaterThan(-1);
    expect(relay).toMatch(/\.stop\(\)/);
  });

  test('PRF180_relay-app.ts는 payment-svc 이름으로 Outbox 릴레이와 공용 정비 일을 돈다', () => {
    const app = code('relay-app.ts');
    expect(app).toMatch(/\bstartOutboxRelayProcess\(/);
    expect(app).toMatch(/\bplatformMaintenanceTasks\(/);
    expect(app).toMatch(/'payment-svc'/);
  });

  test('PRF180_v0 모놀리스가 가져오는 index.ts는 서버 쪽(Nest·gRPC·Drizzle)을 끌고 가지 않는다', () => {
    const index = code('modules/payment/index.ts');
    expect(index).not.toMatch(/server\.js|payment\.module|payment\.grpc|drizzle|@nestjs|@grpc/);
  });

  test("P-T53_리뷰 고침 L6: gRPC 포트를 열 때까지 준비 상태가 아니다(readiness.register('grpc')가 listen 앞, complete가 포트를 연 뒤)", () => {
    const main = code('start.ts');
    const register = main.indexOf("readiness.register('grpc')");
    const listen = main.indexOf('service.listen()');
    const open = main.indexOf('await startGrpcServer(');
    const complete = main.indexOf("readiness.complete('grpc')");
    expect(register, 'register').toBeGreaterThan(-1);
    expect(register, 'register < listen').toBeLessThan(listen);
    expect(open, 'listen < 포트 열기').toBeGreaterThan(listen);
    expect(complete, '포트 열기 < complete').toBeGreaterThan(open);
  });

  test('P-T53_리뷰 고침 L6: SIGTERM의 첫 줄에서 준비 상태를 내린다(docs/devops.md §6.4)', () => {
    const main = code('start.ts');
    const handler = main.slice(main.indexOf('const shutdown = (): Promise<void> => {'));
    const firstStatement = handler
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .find((l) => l !== '');
    expect(firstStatement).toMatch(/^service\.readiness\.register\(/);
  });
});

describe('빌드와 CI(리뷰 고침)', () => {
  const SERVICE = fileURLToPath(new URL('..', import.meta.url));
  const ROOT = join(SERVICE, '..', '..');
  const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

  /** file에서 시작해 상대 가져오기를 따라간 파일들의 바깥 가져오기 이름 */
  function bareImports(file: string, seen = new Set<string>()): Set<string> {
    if (seen.has(file)) return new Set();
    seen.add(file);
    const out = new Set<string>();
    const source = readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/^(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm) as Iterable<RegExpMatchArray>) {
      if (spec!.startsWith('.')) for (const s of bareImports(join(file, '..', spec!.replace(/\.js$/, '.ts')), seen)) out.add(s);
      else out.add(spec!);
    }
    return out;
  }

  test('P-T53_리뷰 고침 H1: v0 이미지는 payment-svc의 공개 면만 컴파일한다(Dockerfile은 build:lib, 전체 build를 부르지 않는다)', () => {
    const dockerfile = read('services/v0-monolith/Dockerfile');
    expect(dockerfile).toMatch(/pnpm --filter @peaket\/payment-svc build:lib\b/);
    expect(dockerfile).not.toMatch(/pnpm --filter @peaket\/payment-svc build\b(?!:)/);
    // pnpm deploy가 의존 패키지 폴더를 통째로 복사하므로 서버 원본·시험·마이그레이션은 지운다
    expect(dockerfile).toMatch(/cd node_modules\/\.pnpm\/@peaket\+payment-svc@\*\/node_modules\/@peaket\/payment-svc \\\r?\n && rm -rf src test test-int scripts migrations/);
    expect((JSON.parse(read('services/payment-svc/package.json')) as { scripts: Record<string, string> }).scripts['build:lib']).toBe('tsc -p tsconfig.lib.json');
    expect((JSON.parse(read('services/payment-svc/tsconfig.lib.json')) as { include: string[] }).include).toEqual(['src/modules/payment/index.ts']);
  });

  test('P-T53_리뷰 고침 H1: 공개 면의 가져오기를 끝까지 따라가도 contracts·gRPC·Nest·Drizzle이 없다', () => {
    const imports = [...bareImports(join(SRC, 'modules/payment/index.ts'))];
    expect(imports.filter((s) => /@peaket\/contracts|@grpc|@nestjs|drizzle|^pg$/.test(s))).toEqual([]);
  });

  test('P-T53_리뷰 고침 H2: 통합 시험 설정은 stream-worker를 원본으로 잇는다(패키지 dist 없이도 릴레이 시험이 뜬다)', () => {
    const config = read('services/payment-svc/vitest.integration.config.mjs');
    expect(config).toMatch(/find: \/\^@peaket\\\/platform\\\/stream-worker\$\//);
    expect(config).toContain("src('../../packages/platform/src/stream-worker.ts')");
  });

  test('P-T53_리뷰 고침 H2: CI는 payment-svc 통합 시험 앞에서 그 서비스와 의존 패키지의 dist를 만든다', () => {
    const ci = read('.github/workflows/ci-node.yml');
    const build = ci.indexOf('turbo run build --filter=@peaket/payment-svc...');
    const run = ci.indexOf('pnpm --filter @peaket/payment-svc test:integration');
    expect(build, 'turbo build 단계').toBeGreaterThan(-1);
    expect(build, 'build < test:integration').toBeLessThan(run);
    expect(run).toBeGreaterThan(-1);
  });
});
