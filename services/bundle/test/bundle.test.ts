// 합본 단위 시험(BUILD_ORDER PRF-215, ADR-0262 결정 4): 설정 검사(local·ci 밖 시작 거부), 환경 파일, 서비스별 환경 값 나누기, 포트 겹침,
// 켜고 닫는 차례(대역 서비스), 관리 포트의 /ready·/metrics 모으기. 실제 서비스를 띄우는 시험은 test-int/start-files.int.test.ts다.
// 시험 값은 코드 상수와 다르게 고른다(관리 포트 기본 9464 대신 19_464 등, docs/architecture.md §8.6 '자주 놓친 결함').
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { assertDistinctPorts, BUNDLE_SERVICES, type BundleConfig, type BundleService, DEFAULT_BUNDLE_MANAGEMENT_PORT, loadBundleConfig, parseEnvFile, portsOf, type ServiceStarter, serviceEnv, startBundle } from '../src/bundle.js';
import { mergeExposition, startManagement } from '../src/management.js';

const BASE = { PEAKET_ENV: 'local', PEAKET_BUNDLE_SERVICES: 'payment-svc,purchase-svc,admission-ctrl,queue-svc', PEAKET_BUNDLE_ENV_DIR: '/etc/peaket/bundle' };

describe('loadBundleConfig: 시작할 수 있는 환경과 서비스 목록', () => {
  test.each([['local'], ['ci']])('PRF215_PEAKET_ENV=%s면 시작한다', (PEAKET_ENV) => {
    expect(loadBundleConfig({ ...BASE, PEAKET_ENV }).env).toBe(PEAKET_ENV);
  });

  test.each([['prod'], ['staging'], ['demo'], ['dev'], ['LOCAL'], [' local'], ['']])('PRF215_PEAKET_ENV=%j면 시작하지 않는다(운영에 배포하지 않는 시험 도구)', (PEAKET_ENV) => {
    expect(() => loadBundleConfig({ ...BASE, PEAKET_ENV })).toThrow(/local·ci에서만/);
  });

  test('PRF215_PEAKET_ENV가 없으면 시작하지 않는다(빈 값을 local로 보지 않는다)', () => {
    const { PEAKET_ENV: _e, ...rest } = BASE;
    expect(() => loadBundleConfig(rest)).toThrow(/local·ci에서만/);
  });

  test('PRF215_서비스 목록은 적은 차례와 상관없이 켜는 차례(결제 → 구매 → 입장 제어 → 대기열)로 맞춘다', () => {
    expect(loadBundleConfig({ ...BASE, PEAKET_BUNDLE_SERVICES: ' queue-svc , payment-svc ' }).services).toEqual(['payment-svc', 'queue-svc']);
    expect(loadBundleConfig(BASE).services).toEqual(['payment-svc', 'purchase-svc', 'admission-ctrl', 'queue-svc']);
    expect(BUNDLE_SERVICES).toEqual(['payment-svc', 'purchase-svc', 'admission-ctrl', 'queue-svc']);
  });

  test.each([
    ['', /비었다/],
    [' , ', /비었다/],
    ['queue-svc,trust-svc', /모르는 서비스가 있다: trust-svc/],
    ['queue-svc,queue-svc', /두 번 있다: queue-svc/],
    ['Queue-svc', /모르는 서비스/],
  ])('PRF215_서비스 목록 %j는 시작하지 않는다', (list, message) => {
    expect(() => loadBundleConfig({ ...BASE, PEAKET_BUNDLE_SERVICES: list })).toThrow(message);
  });

  test('PRF215_환경 파일 폴더가 없으면 시작하지 않는다', () => {
    expect(() => loadBundleConfig({ ...BASE, PEAKET_BUNDLE_ENV_DIR: '  ' })).toThrow(/PEAKET_BUNDLE_ENV_DIR/);
  });

  test('PRF215_관리 포트는 없으면 9464, 경계 1·65535는 받고 0·65536·소수·글은 받지 않는다', () => {
    expect(loadBundleConfig(BASE).managementPort).toBe(9464);
    expect(DEFAULT_BUNDLE_MANAGEMENT_PORT).toBe(9464);
    expect(loadBundleConfig({ ...BASE, PEAKET_MANAGEMENT_PORT: '1' }).managementPort).toBe(1);
    expect(loadBundleConfig({ ...BASE, PEAKET_MANAGEMENT_PORT: '65535' }).managementPort).toBe(65_535);
    for (const bad of ['0', '65536', '9464.5', 'abc', '-1', '1e4']) expect(() => loadBundleConfig({ ...BASE, PEAKET_MANAGEMENT_PORT: bad }), bad).toThrow(/1~65535/);
  });
});

describe('parseEnvFile: 서비스별 환경 파일', () => {
  test('PRF215_KEY=값 줄만 읽고 빈 줄·주석은 건너뛰며 값은 = 뒤 그대로다(JSON의 =·따옴표를 풀지 않는다, CRLF도 읽는다)', () => {
    const text = '# 주석\r\nPORT=18_081\r\n\r\n  # 들여쓴 주석\nPEAKET_ADMISSION_JWKS={"keys":[{"k":"a=b"}]}\nEMPTY=\nQUOTED="x"\n';
    expect(parseEnvFile(text)).toEqual({ PORT: '18_081', PEAKET_ADMISSION_JWKS: '{"keys":[{"k":"a=b"}]}', EMPTY: '', QUOTED: '"x"' });
  });

  test('PRF215_같은 이름이 두 번이거나, 이름이 대문자·숫자·밑줄이 아니거나, =가 없으면 Error이고 글에 값을 싣지 않는다', () => {
    expect(() => parseEnvFile('A=1\nA=2', 'queue-svc.env')).toThrow(/queue-svc\.env에 A가 두 번/);
    expect(() => parseEnvFile('lower=1')).toThrow(/2|1째 줄의 이름/);
    expect(() => parseEnvFile('9A=1')).toThrow(/1째 줄의 이름/);
    expect(() => parseEnvFile('X=1\nsecret-without-equals-sk_live_123')).toThrow(/2째 줄에 KEY=값 꼴이 아니다/);
    let message = '';
    try {
      parseEnvFile('PEAKET_KEY=sk_live_ab12\nPEAKET_KEY=sk_live_cd34');
    } catch (e) {
      message = String(e);
    }
    expect(message).not.toMatch(/sk_live/);
  });
});

describe('serviceEnv·포트: 서비스마다 다른 환경 값', () => {
  const common = { PEAKET_ENV: 'ci', PEAKET_POD: 'bundle-abc', PEAKET_MANAGEMENT_PORT: '19464', KUBERNETES_SERVICE_HOST: '10.96.0.1' };

  test('PRF215_공통 값 위에 그 서비스 파일만 얹는다(다른 서비스 파일의 값은 들어가지 않는다)', () => {
    const queue = serviceEnv('queue-svc', common, { PORT: '18080', PEAKET_MANAGEMENT_PORT: '19471', PEAKET_QUEUE_REDIS_URL: 'redis://q:6379' });
    const purchase = serviceEnv('purchase-svc', common, { PORT: '18081', PEAKET_MANAGEMENT_PORT: '19473', PEAKET_SEAT_REDIS_URL: 'redis://s:6379' });
    expect(queue).toMatchObject({ PEAKET_ENV: 'ci', PEAKET_POD: 'bundle-abc', PORT: '18080', PEAKET_MANAGEMENT_PORT: '19471', PEAKET_QUEUE_REDIS_URL: 'redis://q:6379' });
    expect(queue).not.toHaveProperty('PEAKET_SEAT_REDIS_URL');
    expect(purchase).not.toHaveProperty('PEAKET_QUEUE_REDIS_URL');
    // 합본 관리 포트(공통 값)는 서비스 파일이 덮는다
    expect(purchase.PEAKET_MANAGEMENT_PORT).toBe('19473');
  });

  test.each([['PEAKET_ENV'], ['OTEL_SERVICE_NAME'], ['NODE_OPTIONS'], ['NODE_EXTRA_CA_CERTS'], ['PEAKET_BUNDLE_SERVICES'], ['PEAKET_BUNDLE_ENV_DIR'], ['KUBERNETES_SERVICE_HOST'], ['KUBERNETES_PORT'], ['OTEL_TRACES_EXPORTER'], ['NODE_ENV'], ['HOSTNAME'], ['PEAKET_POD'], ['PEAKET_AZ'], ['POD_NAMESPACE']])('PRF215_서비스 파일은 프로세스 공통 값 %s를 적지 못한다', (key) => {
    expect(() => serviceEnv('payment-svc', common, { PORT: '18084', PEAKET_MANAGEMENT_PORT: '19474', [key]: 'prod' })).toThrow(new RegExp(`payment-svc\\.env에 ${key}를 적지 않는다`));
  });

  test.each([['PORT'], ['PEAKET_MANAGEMENT_PORT']])('PRF215_서비스 파일에 %s가 없으면(공통 값을 함께 집어 겹친다) 시작하지 않는다', (key) => {
    const file: Record<string, string> = { PORT: '18082', PEAKET_MANAGEMENT_PORT: '19472' };
    delete file[key];
    expect(() => serviceEnv('admission-ctrl', common, file)).toThrow(new RegExp(`admission-ctrl\\.env에 ${key}가 없다`));
  });

  test('PRF215_포트가 서비스끼리·합본 관리 포트와 겹치면 시작하지 않고, payment-svc·queue-svc는 gRPC 포트(없으면 기본 50051)도 센다', () => {
    const p = (svc: BundleService, env: Record<string, string>) => portsOf(svc, env);
    expect(p('payment-svc', { PORT: '18084', PEAKET_MANAGEMENT_PORT: '19474', PEAKET_GRPC_PORT: '15051' }).map((x) => x.port)).toEqual([18_084, 19_474, 15_051]);
    // queue-svc도 업무 gRPC(VerificationAppealService, BOT-090)를 연다. 파일에 없으면 두 서비스 모두 기본 50051이라 겹침으로 잡는다(rebase로 BAT-200을 실을 때)
    expect(p('queue-svc', { PORT: '18080', PEAKET_MANAGEMENT_PORT: '19471', PEAKET_GRPC_PORT: '15052' }).map((x) => x.port)).toEqual([18_080, 19_471, 15_052]);
    expect(p('queue-svc', { PORT: '18080', PEAKET_MANAGEMENT_PORT: '19471' }).map((x) => x.port)).toEqual([18_080, 19_471, 50_051]);
    expect(p('purchase-svc', { PORT: '18081', PEAKET_MANAGEMENT_PORT: '19473', PEAKET_GRPC_PORT: '15053' }).map((x) => x.port)).toEqual([18_081, 19_473]);
    expect(() => assertDistinctPorts(19_464, [...p('payment-svc', { PORT: '18084', PEAKET_MANAGEMENT_PORT: '19474' }), ...p('queue-svc', { PORT: '18080', PEAKET_MANAGEMENT_PORT: '19471' })])).toThrow(/50051가 겹친다: payment-svc PEAKET_GRPC_PORT와 queue-svc PEAKET_GRPC_PORT/);
    expect(() => assertDistinctPorts(19_464, [{ name: 'queue-svc PORT', port: 18_080 }, { name: 'purchase-svc PORT', port: 18_080 }])).toThrow(/18080가 겹친다: queue-svc PORT와 purchase-svc PORT/);
    expect(() => assertDistinctPorts(19_464, [{ name: 'queue-svc PEAKET_MANAGEMENT_PORT', port: 19_464 }])).toThrow(/합본 PEAKET_MANAGEMENT_PORT와 queue-svc/);
    expect(() => assertDistinctPorts(19_464, [{ name: 'a', port: 19_463 }, { name: 'b', port: 19_465 }])).not.toThrow();
  });
});

/** 대역 서비스: 받은 환경 값과 켜고 닫힌 차례를 적는다 */
function fakes(o: { failStart?: BundleService; failClose?: BundleService; fatalAfterStart?: BundleService } = {}) {
  const events: string[] = [];
  const envs: Partial<Record<BundleService, Record<string, string | undefined>>> = {};
  const fatals: Partial<Record<BundleService, (err: unknown) => void>> = {};
  const closes: Record<string, number> = {};
  const starter =
    (svc: BundleService): (() => Promise<ServiceStarter>) =>
    async () =>
    async (opts) => {
      events.push(`start ${svc}`);
      envs[svc] = opts.env;
      if (opts.onFatal) fatals[svc] = opts.onFatal;
      if (o.failStart === svc) throw new Error(`${svc} 시작 실패(시험)`);
      if (o.fatalAfterStart === svc) queueMicrotask(() => opts.onFatal?.(new Error('Kafka 소비자를 켜지 못함(시험)')));
      return {
        close: async () => {
          closes[svc] = (closes[svc] ?? 0) + 1;
          events.push(`close ${svc}`);
          if (o.failClose === svc) throw new Error(`${svc} 닫기 실패(시험)`);
        },
      };
    };
  const starters = Object.fromEntries(BUNDLE_SERVICES.map((s) => [s, starter(s)])) as Record<BundleService, () => Promise<ServiceStarter>>;
  return { events, envs, fatals, closes, starters };
}

const FILES: Record<BundleService, string> = {
  'payment-svc': 'PORT=18084\nPEAKET_MANAGEMENT_PORT=19474\nPEAKET_GRPC_PORT=15051\nPEAKET_DATABASE_URL=postgres://payment\n',
  'purchase-svc': 'PORT=18081\nPEAKET_MANAGEMENT_PORT=19473\nPEAKET_SEAT_REDIS_URL=redis://seat:6379\nPEAKET_PAYMENT_GRPC_ADDR=127.0.0.1:15051\n',
  'admission-ctrl': 'PORT=18082\nPEAKET_MANAGEMENT_PORT=19472\nPEAKET_QUEUE_REDIS_URL=redis://queue:6379\n',
  'queue-svc': 'PORT=18080\nPEAKET_MANAGEMENT_PORT=19471\nPEAKET_QUEUE_REDIS_URL=redis://queue:6379\n',
};
const config = (services: BundleService[] = [...BUNDLE_SERVICES]): BundleConfig => ({ env: 'ci', services, envDir: '/x/envs', managementPort: 19_464 });
const reader = (files: Partial<Record<BundleService, string>> = FILES, reads: string[] = []) => async (path: string) => {
  reads.push(path);
  const name = path.replace(/\\/g, '/').split('/').pop()!.replace(/\.env$/, '') as BundleService;
  const text = files[name];
  if (text === undefined) throw new Error(`ENOENT ${path}`);
  return text;
};

describe('startBundle: 켜고 닫는 차례(대역 서비스)', () => {
  test('PRF215_켜는 차례대로 켜고 서비스마다 제 파일의 값만 넘기며, 반대 차례로 닫는다', async () => {
    const f = fakes();
    const b = await startBundle({ config: config(), common: { PEAKET_ENV: 'ci', PEAKET_POD: 'p-1' }, starters: f.starters, readEnvFile: reader() });
    expect(f.events).toEqual(['start payment-svc', 'start purchase-svc', 'start admission-ctrl', 'start queue-svc']);
    expect(b.services).toEqual([
      { service: 'payment-svc', managementPort: 19_474 },
      { service: 'purchase-svc', managementPort: 19_473 },
      { service: 'admission-ctrl', managementPort: 19_472 },
      { service: 'queue-svc', managementPort: 19_471 },
    ]);
    expect(f.envs['purchase-svc']).toMatchObject({ PEAKET_ENV: 'ci', PEAKET_POD: 'p-1', PORT: '18081', PEAKET_SEAT_REDIS_URL: 'redis://seat:6379' });
    expect(f.envs['purchase-svc']).not.toHaveProperty('PEAKET_DATABASE_URL');
    expect(f.envs['queue-svc']).not.toHaveProperty('PEAKET_SEAT_REDIS_URL');
    expect(f.envs['payment-svc']).not.toHaveProperty('PEAKET_QUEUE_REDIS_URL');
    await b.close();
    expect(f.events.slice(4)).toEqual(['close queue-svc', 'close admission-ctrl', 'close purchase-svc', 'close payment-svc']);
  });

  test('PRF215_닫기는 여러 번 불러도 서비스마다 한 번만 닫는다', async () => {
    const f = fakes();
    const b = await startBundle({ config: config(), common: {}, starters: f.starters, readEnvFile: reader() });
    const [x, y] = [b.close(), b.close()];
    expect(x).toBe(y);
    await Promise.all([x, y, b.close()]);
    expect(f.closes).toEqual({ 'payment-svc': 1, 'purchase-svc': 1, 'admission-ctrl': 1, 'queue-svc': 1 });
  });

  test('PRF215_고른 서비스의 파일만 읽고 켠다(나머지 서비스 코드는 싣지 않는다)', async () => {
    const f = fakes();
    const reads: string[] = [];
    let loaded = 0;
    const starters = { ...f.starters, 'payment-svc': async () => ((loaded += 1), f.starters['payment-svc']()) };
    const b = await startBundle({ config: config(['queue-svc']), common: {}, starters, readEnvFile: reader({ 'queue-svc': FILES['queue-svc'] }, reads) });
    expect(reads.map((r) => r.replace(/\\/g, '/'))).toEqual(['/x/envs/queue-svc.env']);
    expect(loaded).toBe(0);
    expect(f.events).toEqual(['start queue-svc']);
    await b.close();
  });

  test('PRF215_서비스 하나가 시작에 실패하면 이미 켠 것을 반대 차례로 닫고 그 오류를 던지며 뒤 서비스는 켜지 않는다', async () => {
    const f = fakes({ failStart: 'admission-ctrl' });
    await expect(startBundle({ config: config(), common: {}, starters: f.starters, readEnvFile: reader() })).rejects.toThrow(/admission-ctrl 시작 실패/);
    expect(f.events).toEqual(['start payment-svc', 'start purchase-svc', 'start admission-ctrl', 'close purchase-svc', 'close payment-svc']);
  });

  test('PRF215_포트가 겹치거나 파일이 틀리면 아무 서비스도 켜지 않는다(모두 읽고 검사한 뒤 켠다)', async () => {
    const f = fakes();
    const clash = { ...FILES, 'queue-svc': 'PORT=18081\nPEAKET_MANAGEMENT_PORT=19471\n' };
    await expect(startBundle({ config: config(), common: {}, starters: f.starters, readEnvFile: reader(clash) })).rejects.toThrow(/18081가 겹친다: purchase-svc PORT와 queue-svc PORT/);
    const reserved = { ...FILES, 'queue-svc': `${FILES['queue-svc']}PEAKET_ENV=prod\n` };
    await expect(startBundle({ config: config(), common: {}, starters: f.starters, readEnvFile: reader(reserved) })).rejects.toThrow(/queue-svc\.env에 PEAKET_ENV/);
    await expect(startBundle({ config: config(), common: {}, starters: f.starters, readEnvFile: reader({ ...FILES, 'admission-ctrl': undefined as unknown as string }) })).rejects.toThrow(/ENOENT/);
    expect(f.events).toEqual([]);
  });

  test('PRF215_켠 서비스 하나가 치명적으로 실패하면 모두 반대 차례로 닫고 그 서비스 이름으로 알린다', async () => {
    const f = fakes();
    const fatal: BundleService[] = [];
    const b = await startBundle({ config: config(), common: {}, starters: f.starters, readEnvFile: reader(), onFatal: (s) => fatal.push(s) });
    f.fatals['purchase-svc']!(new Error('Kafka(시험)'));
    await b.close();
    expect(fatal).toEqual(['purchase-svc']);
    expect(f.events.slice(4)).toEqual(['close queue-svc', 'close admission-ctrl', 'close purchase-svc', 'close payment-svc']);
  });

  test('PRF215_서비스가 뜨자마자 치명적으로 실패하면 그 서비스까지 닫고 뒤 서비스는 켜지 않은 채 던진다', async () => {
    const f = fakes({ fatalAfterStart: 'purchase-svc' });
    const fatal: BundleService[] = [];
    await expect(startBundle({ config: config(), common: {}, starters: f.starters, readEnvFile: reader(), onFatal: (s) => fatal.push(s) })).rejects.toThrow(/purchase-svc를 바로 닫았다/);
    expect(fatal).toEqual(['purchase-svc']);
    expect(f.events).toEqual(['start payment-svc', 'start purchase-svc', 'close payment-svc', 'close purchase-svc']);
  });

  test('PRF215_다음 서비스 코드를 싣는 사이에 앞 서비스가 실패하면 그 서비스를 켜지 않는다', async () => {
    const f = fakes();
    const fatal: BundleService[] = [];
    // admission-ctrl 코드를 싣는 동안(20ms) purchase-svc가 실패를 알린다
    const slow = { ...f.starters, 'admission-ctrl': async () => (setTimeout(() => f.fatals['purchase-svc']!(new Error('Kafka(시험)')), 1), await new Promise((r) => setTimeout(r, 20)), f.starters['admission-ctrl']()) };
    await expect(startBundle({ config: config(), common: {}, starters: slow, readEnvFile: reader(), onFatal: (s) => fatal.push(s) })).rejects.toThrow(/admission-ctrl를 켜지 않았다/);
    expect(fatal).toEqual(['purchase-svc']);
    expect(f.events).toEqual(['start payment-svc', 'start purchase-svc', 'close purchase-svc', 'close payment-svc']);
  });

  test('PRF215_코드리뷰낮음_켜는 중에 닫기 신호(SIGTERM)가 오면 켠 것을 반대 차례로 닫고 뒤 서비스는 켜지 않는다', async () => {
    const f = fakes();
    const ac = new AbortController();
    // purchase-svc 코드를 싣는 동안 신호가 온다
    const slow = { ...f.starters, 'purchase-svc': async () => (ac.abort(), f.starters['purchase-svc']()) };
    await expect(startBundle({ config: config(), common: {}, starters: slow, readEnvFile: reader(), stop: ac.signal })).rejects.toThrow(/닫기 신호/);
    expect(f.events).toEqual(['start payment-svc', 'close payment-svc']);
    // 시작 전에 이미 신호가 왔으면 아무것도 켜지 않는다
    const g = fakes();
    await expect(startBundle({ config: config(), common: {}, starters: g.starters, readEnvFile: reader(), stop: AbortSignal.abort() })).rejects.toThrow(/닫기 신호/);
    expect(g.events).toEqual([]);
  });

  test('PRF215_한 서비스의 닫기가 실패해도 나머지를 닫고 실패를 기록한다', async () => {
    const f = fakes({ failClose: 'admission-ctrl' });
    const log: string[] = [];
    const b = await startBundle({ config: config(), common: {}, starters: f.starters, readEnvFile: reader(), log: (e) => log.push(`${e.step} ${e.service}`) });
    await b.close();
    expect(f.events.slice(4)).toEqual(['close queue-svc', 'close admission-ctrl', 'close purchase-svc', 'close payment-svc']);
    expect(log).toContain('close-failed admission-ctrl');
    expect(log).toContain('closed payment-svc');
  });
});

describe('운영 조립: 서비스 시작 함수는 넘긴 환경 값만 읽는다', () => {
  /** 주석을 뺀 소스 */
  const code = (svc: BundleService) =>
    readFileSync(fileURLToPath(new URL(`../../${svc}/src/start.ts`, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\s\/\/ .*$/gm, '');
  const main = (svc: BundleService) => readFileSync(fileURLToPath(new URL(`../../${svc}/src/main.ts`, import.meta.url)), 'utf8').replace(/^\s*\/\/.*$/gm, '');

  test.each(BUNDLE_SERVICES.map((s) => [s]))('PRF215_%s start.ts는 process.env를 읽지 않고(합본이 다른 서비스 값을 섞지 않게) 서비스 뼈대에 env를 넘긴다', (svc) => {
    const c = code(svc);
    expect(c).not.toMatch(/process\.env/);
    expect(c).toMatch(/export async function start\(o: StartOptions\): Promise<StartedService>/);
    expect(/createService\(\{([\s\S]*?)module:/.exec(c)?.[1]).toMatch(/\benv,/);
  });

  test.each(BUNDLE_SERVICES.map((s) => [s]))('PRF215_%s main.ts는 start({ env: process.env })만 부르고 SIGTERM에 close()를 잇는다', (svc) => {
    const m = main(svc);
    expect(m).toMatch(/await start\(\{\s*env: process\.env/);
    expect(m).toMatch(/process\.once\('SIGTERM', \(\) => void service\.close\(\)\)/);
    expect(m.match(/process\.env/g)).toHaveLength(1);
  });

  test('PRF215_변이검토_합본 main.ts는 SIGTERM 처리기를 서비스를 켜기 전에 걸고 그 처리기가 닫기 신호를 내며 그 신호를 startBundle에 넘긴다(켜는 중 SIGTERM)', () => {
    // 행동은 startBundle의 stop 시험(위 '켜는 중에 닫기 신호')이 본다. 여기서는 시작 파일이 그 신호를 잇는지만 본다(최상위 스크립트라 대역으로 띄울 수 없다)
    const m = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const handler = /process\.once\('SIGTERM', \(\) => \{([\s\S]*?)\n\}\);/.exec(m)?.[1];
    expect(handler, 'SIGTERM 처리기').toBeDefined();
    expect(handler).toMatch(/\bstop\.abort\(\)/);
    expect(m.indexOf("process.once('SIGTERM'"), '처리기 < startBundle').toBeLessThan(m.indexOf('await startBundle('));
    expect(/startBundle\(\{([\s\S]*?)\}\);/.exec(m)?.[1]).toMatch(/\bstop: stop\.signal\b/);
  });
});

describe('관리 포트: 서비스 관리 포트를 모은다', () => {
  test('PRF215_지표 묶음별로 합치고 같은 이름·꼬리표 표본은 처음 것만, service 꼬리표가 다른 표본은 모두 둔다', () => {
    const a = [
      '# HELP process_cpu_seconds_total CPU',
      '# TYPE process_cpu_seconds_total counter',
      'process_cpu_seconds_total 1.5',
      '# HELP http_server_request_duration_seconds 요청',
      '# TYPE http_server_request_duration_seconds histogram',
      'http_server_request_duration_seconds_bucket{service="queue-svc",le="0.1"} 3',
      'http_server_request_duration_seconds_sum{service="queue-svc"} 0.2',
      'http_server_request_duration_seconds_count{service="queue-svc"} 3',
      '# TYPE queue_entries_total counter',
      'queue_entries_total{result="ok"} 7',
      '',
    ].join('\n');
    const b = [
      '# HELP process_cpu_seconds_total CPU',
      '# TYPE process_cpu_seconds_total counter',
      'process_cpu_seconds_total 1.6',
      '# HELP http_server_request_duration_seconds 요청',
      '# TYPE http_server_request_duration_seconds histogram',
      'http_server_request_duration_seconds_bucket{service="purchase-svc",le="0.1"} 5',
      'http_server_request_duration_seconds_count{service="purchase-svc"} 5',
      'seat_lua_errors_total{script="hold has space",kind="x"} 0',
    ].join('\r\n');
    expect(mergeExposition([a, b]).split('\n')).toEqual([
      '# HELP process_cpu_seconds_total CPU',
      '# TYPE process_cpu_seconds_total counter',
      'process_cpu_seconds_total 1.5',
      '# HELP http_server_request_duration_seconds 요청',
      '# TYPE http_server_request_duration_seconds histogram',
      'http_server_request_duration_seconds_bucket{service="queue-svc",le="0.1"} 3',
      'http_server_request_duration_seconds_sum{service="queue-svc"} 0.2',
      'http_server_request_duration_seconds_count{service="queue-svc"} 3',
      'http_server_request_duration_seconds_bucket{service="purchase-svc",le="0.1"} 5',
      'http_server_request_duration_seconds_count{service="purchase-svc"} 5',
      '# TYPE queue_entries_total counter',
      'queue_entries_total{result="ok"} 7',
      'seat_lua_errors_total{script="hold has space",kind="x"} 0',
      '',
    ]);
    expect(mergeExposition([])).toBe('');
  });

  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });
  /** 서비스 관리 포트 대역 */
  const fakeService = async (ready: number, metrics: string): Promise<number> => {
    const s = createServer((req, res) => {
      if (req.url === '/ready') res.writeHead(ready).end('{}');
      else if (req.url === '/metrics') res.writeHead(200).end(metrics);
      else res.writeHead(404).end();
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const a = s.address();
    return typeof a === 'object' && a ? a.port : 0;
  };

  test('PRF215_/ready는 켜는 중이면 503과 남은 서비스, 서비스 하나라도 503이면 503과 그 이름, 모두 200일 때만 200이다. /livez는 늘 200', async () => {
    const q = await fakeService(200, 'queue_entries_total 1\n');
    const p = await fakeService(503, 'seat_holds_total 2\n');
    let state: { pending: string[]; services: { service: string; managementPort: number }[] } = { pending: ['payment-svc', 'queue-svc'], services: [] };
    const m = await startManagement(0, { pending: () => state.pending, services: () => state.services }, '127.0.0.1');
    try {
      const at = (path: string) => fetch(`http://127.0.0.1:${m.port}${path}`);
      let r = await at('/ready');
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ status: 'starting', pending: ['payment-svc', 'queue-svc'] });
      expect((await at('/livez')).status).toBe(200);
      state = { pending: [], services: [{ service: 'purchase-svc', managementPort: p }, { service: 'queue-svc', managementPort: q }] };
      r = await at('/ready');
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ status: 'starting', pending: ['purchase-svc'] });
      state = { pending: [], services: [{ service: 'queue-svc', managementPort: q }] };
      expect((await at('/ready')).status).toBe(200);
      state = { pending: [], services: [] };
      expect((await at('/ready')).status, '켠 서비스가 없으면 준비가 아니다').toBe(503);
      state = { pending: [], services: [{ service: 'purchase-svc', managementPort: p }, { service: 'queue-svc', managementPort: q }] };
      const metrics = await at('/metrics');
      expect(metrics.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
      expect(await metrics.text()).toBe('seat_holds_total 2\nqueue_entries_total 1\n');
      expect((await at('/nope')).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${m.port}/ready`, { method: 'POST' })).status).toBe(405);
    } finally {
      await m.close();
    }
  });

  test('PRF215_닿지 않는 서비스 관리 포트는 준비가 아니고 지표에서 빠진다(관리 서버는 죽지 않는다)', async () => {
    const q = await fakeService(200, 'queue_entries_total 1\n');
    const dead = await fakeService(200, '');
    await new Promise((r) => servers.pop()!.close(r));
    const m = await startManagement(0, { pending: () => [], services: () => [{ service: 'queue-svc', managementPort: q }, { service: 'admission-ctrl', managementPort: dead }] }, '127.0.0.1');
    try {
      const r = await fetch(`http://127.0.0.1:${m.port}/ready`);
      expect(await r.json()).toEqual({ status: 'starting', pending: ['admission-ctrl'] });
      expect(await (await fetch(`http://127.0.0.1:${m.port}/metrics`)).text()).toBe('queue_entries_total 1\n');
    } finally {
      await m.close();
    }
  });
});
