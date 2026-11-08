// payment-svc 프로세스 설정(loadPaymentServiceConfig)과 운영 조립(main.ts·relay.ts·relay-app.ts)의 글 검사(BUILD_ORDER PRF-180, docs/features/payment.md §2 '프로세스'·'연결 풀', docs/verification.md §4.1).
// 조립은 빠뜨려도 형 오류가 나지 않는 곳만 글로 본다(purchase-svc payment-result-pull.test.ts의 '운영 조립'과 같은 방식). 실제로 띄워 보는 것은 test-int가 본다.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { DEFAULT_PAYMENT_GRPC_PORT, loadPaymentServiceConfig, PAYMENT_BATCH_POOL_MAX, PAYMENT_HOT_POOL_MAX } from '../src/config.js';

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

describe('운영 조립(글 검사)', () => {
  test('PRF180_뼈대 표시가 src에 남아 있지 않다', () => {
    const left = sourceFiles().filter((f) => readFileSync(join(SRC, f), 'utf8').includes('구현 전(뼈대)'));
    expect(left).toEqual([]);
  });

  /** createDatabase({ … }) 호출 몸통들 */
  const databaseCalls = (main: string): string[] => [...main.matchAll(/createDatabase\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]!);

  test('PRF180_main.ts는 핫패스 풀과 일반 풀을 따로 만든다(이름 payment-svc·payment-svc-batch, 크기는 config 상수)', () => {
    const calls = databaseCalls(code('main.ts'));
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
    expect(code('main.ts')).toMatch(/new DrizzlePaymentStore\(\{[\s\S]*?\bbatchDatabase\b[\s\S]*?\}\)/);
  });

  test('PRF180_main.ts는 지표를 서비스 레지스트리에 붙이고 PaymentService에 처리기를 묶는다', () => {
    const main = code('main.ts');
    expect(main).toMatch(/\bnew PromPaymentCommandSignals\(/);
    expect(main).toMatch(/\.register\(service\.metrics\.registry\)/);
    expect(main).toMatch(/\bstartGrpcServer\(/);
    expect(main).toMatch(/\bpaymentPackage\(\)/);
    expect(main).toMatch(/\bPaymentService\.service\b/);
    expect(main).toMatch(/\bpaymentServiceHandlers\(/);
    expect(main).toMatch(/\bloadPaymentServiceConfig\(process\.env\)/);
  });

  test('PRF180_main.ts의 SIGTERM은 gRPC 포트 → 서비스 → DB 풀 둘 차례로 닫는다', () => {
    const main = code('main.ts');
    const at = main.indexOf('SIGTERM');
    expect(at, 'main.ts에 SIGTERM 처리가 있다').toBeGreaterThan(-1);
    const closes = [...main.slice(at).matchAll(/(\w+)\s*\??\.close\(\)/g)].map((m) => m[1]!);
    expect(closes.length, closes.join(',')).toBeGreaterThanOrEqual(4);
    expect(closes[0], closes.join(',')).toMatch(/grpc/i);
    expect(closes[1], closes.join(',')).toBe('service');
    expect(closes.slice(2).filter((n) => /database|db|pool/i.test(n)), closes.join(',')).toHaveLength(2);
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
    const main = code('main.ts');
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
    const main = code('main.ts');
    const handler = main.slice(main.indexOf("process.once('SIGTERM'"));
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
