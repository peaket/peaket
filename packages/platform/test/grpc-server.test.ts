// 공용 업무 gRPC 서버의 우아한 종료·설정·호출 지표(BUILD_ORDER BAS-080, docs/devops.md §6.4 ②·D-T27, docs/observability.md §3 'gRPC 서버 지표',
// ADR-0303 결정 1·2). 같은 프로세스 단위 시험이다. 진짜 SIGTERM과 종료 차례는 test-int/shutdown.int.test.ts가 본다.
// 값은 정본에서 숫자로 적는다(마감 10초 [가정], 기본 포트 50051 [가정], headless-round-robin 연결 수명 30초 [가정]).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GRPC_SERVER_DEFAULTS, PlatformConfigError, PlatformMetrics, loadPlatformConfig, startGrpcServer, type StartedGrpcServer } from '../src/index.js';
import { sample } from './fixture.js';

// 서버 옵션을 엿본다(부하 분산 프로필이 연결 수명으로 이어지는지). 동작은 진짜 grpc.Server 그대로다
const seen = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('@grpc/grpc-js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@grpc/grpc-js')>();
  class Server extends real.Server {
    constructor(options?: grpc.ServerOptions) {
      seen.options.push({ ...(options ?? {}) });
      super(options);
    }
  }
  return { ...real, Server };
});

const bytes = {
  requestSerialize: (b: Buffer) => b,
  requestDeserialize: (b: Buffer) => b,
  responseSerialize: (b: Buffer) => b,
  responseDeserialize: (b: Buffer) => b,
};
const SLOW = '/peaket.test.v1.SlowService/Slow';
const OTHER = '/peaket.test.v1.SlowService/Other';
const ServerDef = { Slow: { path: SLOW, requestStream: false, responseStream: false, ...bytes } } as unknown as grpc.ServiceDefinition;
// 부르는 쪽은 서버에 없는 메서드(Other)도 안다
const ClientDef = { ...ServerDef, Other: { path: OTHER, requestStream: false, responseStream: false, ...bytes } } as unknown as grpc.ServiceDefinition;
const Client = grpc.makeGenericClientConstructor(ClientDef, 'SlowService');

/** 요청 본문: 'nf'면 NOT_FOUND, 숫자면 그 ms만큼 기다렸다 'done-<ms>' */
const handlers: grpc.UntypedServiceImplementation = {
  Slow: (call: grpc.ServerUnaryCall<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) => {
    const text = call.request.toString();
    if (text === 'nf') return cb({ code: grpc.status.NOT_FOUND, details: '없다' });
    setTimeout(() => cb(null, Buffer.from(`done-${text}`)), Number(text));
  },
};

const servers: StartedGrpcServer[] = [];
const clients: grpc.Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  seen.options.length = 0;
});

async function serve(o: { drainMs?: number; metrics?: PlatformMetrics; profile?: 'service' | 'headless-round-robin' } = {}) {
  const s = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: ServerDef, handlers }], profile: o.profile ?? 'service', ...(o.metrics ? { metrics: o.metrics } : {}), ...(o.drainMs === undefined ? {} : { drainMs: o.drainMs }) });
  servers.push(s);
  return s;
}

function client(port: number) {
  const c = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as grpc.Client & Record<string, (req: Buffer, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, r?: Buffer) => void) => void>;
  clients.push(c);
  return c;
}

/** 호출 하나: 끝난 시각과 상태 */
function call(c: ReturnType<typeof client>, method: 'Slow' | 'Other', body: string, deadlineMs = 15_000) {
  return new Promise<{ code: number; body?: string; at: number }>((resolve) => {
    c[method]!(Buffer.from(body), new grpc.Metadata(), { deadline: Date.now() + deadlineMs }, (err, res) => {
      resolve(err ? { code: err.code, at: performance.now() } : { code: grpc.status.OK, body: res!.toString(), at: performance.now() });
    });
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('D-T27 공용 gRPC 서버의 우아한 종료', () => {
  test('D-T27_2초걸리는호출중에_close하면_그호출은OK로끝나고_close는호출이끝난직후돌아오며_새호출은UNAVAILABLE이다', { timeout: 20_000 }, async () => {
    const s = await serve();
    const c = client(s.port);
    const t0 = performance.now();
    const inflight = call(c, 'Slow', '2000');
    await sleep(500);
    const closing = s.close();
    // close 뒤의 새 연결·새 호출은 받지 않는다
    await sleep(100);
    const late = await call(client(s.port), 'Slow', '1', 1_500);
    await closing;
    const closedAt = performance.now();
    const r = await inflight;
    expect(r).toMatchObject({ code: grpc.status.OK, body: 'done-2000' });
    expect(late.code).toBe(grpc.status.UNAVAILABLE);
    // 바로 끊지 않았다(2초 호출을 기다렸다)
    expect(closedAt - t0).toBeGreaterThanOrEqual(1_900);
    // 마감 10초를 다 쓰지 않고 호출이 끝나면 바로 돌아온다
    expect(closedAt - r.at).toBeLessThan(1_000);
    expect(closedAt - t0).toBeLessThan(4_000);
  });

  test('D-T27_마감을넘긴호출만끊고_지표는CANCELLED한번이며_기본마감은10000ms다', { timeout: 10_000 }, async () => {
    expect(GRPC_SERVER_DEFAULTS.drainMs).toBe(10_000);
    const metrics = new PlatformMetrics('demo-svc');
    const s = await serve({ drainMs: 300, metrics });
    const c = client(s.port);
    const inflight = call(c, 'Slow', '1000');
    await sleep(100);
    const t0 = performance.now();
    const closed = await Promise.race([s.close().then(() => 'closed' as const), sleep(2_000).then(() => 'hung' as const)]);
    const closedIn = performance.now() - t0;
    expect(closed).toBe('closed');
    expect(closedIn).toBeGreaterThanOrEqual(250);
    expect(closedIn).toBeLessThan(900);
    const r = await inflight;
    expect([grpc.status.CANCELLED, grpc.status.UNAVAILABLE]).toContain(r.code);
    // 끊긴 처리기가 나중에 답을 보내도(1초 뒤) 두 번 세지 않는다
    await sleep(1_100);
    const text = await metrics.registry.metrics();
    expect(sample(text, 'rpc_server_call_duration_seconds_count', { service: 'demo-svc', method: SLOW.slice(1), code: 'CANCELLED' })).toBe(1);
    expect(sample(text, 'rpc_server_call_duration_seconds_count', { service: 'demo-svc', method: SLOW.slice(1), code: 'OK' })).toBeUndefined();
  });

  test('D-T27_close를두번불러도_같은약속이고_처리중호출이없으면_바로닫힌다', async () => {
    const s = await serve();
    const t0 = performance.now();
    const a = s.close();
    expect(s.close()).toBe(a);
    await a;
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe('BAS-080 gRPC 포트와 부하 분산 프로필(ADR-0303 결정 1)', () => {
  test('PEAKET_GRPC_PORT_없으면50051_주면그값_0은local·ci에서만_범위밖·글자는어디서나시작실패', () => {
    expect(loadPlatformConfig({}).grpcPort).toBe(50051);
    expect(loadPlatformConfig({ PEAKET_ENV: 'local', PEAKET_GRPC_PORT: '' }).grpcPort).toBe(50051);
    expect(loadPlatformConfig({ PEAKET_ENV: 'local', PEAKET_GRPC_PORT: '50052' }).grpcPort).toBe(50052);
    expect(loadPlatformConfig({ PEAKET_ENV: 'prod', PEAKET_GRPC_PORT: '65535' }).grpcPort).toBe(65535);
    for (const env of ['local', 'ci']) expect(loadPlatformConfig({ PEAKET_ENV: env, PEAKET_GRPC_PORT: '0' }).grpcPort).toBe(0);
    for (const env of ['demo', 'staging', 'prod']) expect(() => loadPlatformConfig({ PEAKET_ENV: env, PEAKET_GRPC_PORT: '0' }), env).toThrow(PlatformConfigError);
    for (const env of ['local', 'ci', 'prod']) {
      for (const raw of ['70000', '65536', 'abc', '-1', '5005.1', '1e4', ' 50051']) {
        expect(() => loadPlatformConfig({ PEAKET_ENV: env, PEAKET_GRPC_PORT: raw }), `${env} ${raw}`).toThrow(PlatformConfigError);
      }
    }
  });

  test('설정의grpcLbProfile이_서버옵션으로이어져_headless-round-robin이면연결수명30000ms_service면없다', async () => {
    const profile = loadPlatformConfig({ PEAKET_ENV: 'ci', PEAKET_GRPC_LB_PROFILE: 'headless-round-robin' }).grpcLbProfile;
    expect(profile).toBe('headless-round-robin');
    await serve({ profile });
    expect(seen.options.at(-1)?.['grpc.max_connection_age_ms']).toBe(30_000);
    await serve({ profile: loadPlatformConfig({ PEAKET_ENV: 'ci' }).grpcLbProfile });
    expect(seen.options.at(-1)).not.toHaveProperty('grpc.max_connection_age_ms');
  });

  test('서비스의업무gRPC서버시작은_설정의grpcLbProfile을넘긴다(service를박아두지않는다)', () => {
    const root = fileURLToPath(new URL('../../../services', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== 'node_modules' && name !== 'dist' && name !== 'test' && name !== 'test-int') walk(p);
        } else if (p.endsWith('.ts')) files.push(p);
      }
    };
    for (const svc of readdirSync(root)) if (statSync(join(root, svc, 'src'), { throwIfNoEntry: false })?.isDirectory()) walk(join(root, svc, 'src'));
    const calls: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/await startGrpcServer\(\{([\s\S]*?)\}\)/g)) {
        calls.push(f);
        expect(m[1], f).toMatch(/profile:\s*service\.config\.grpcLbProfile/);
      }
    }
    // identity·payment·queue·ticket·trust가 업무 gRPC 포트를 연다
    expect(new Set(calls.map((f) => f.split(/[\\/]services[\\/]/)[1]!.split(/[\\/]/)[0])).size).toBeGreaterThanOrEqual(5);
  });
});

describe('BAS-080 gRPC 서버 지표(docs/observability.md §3)', () => {
  test('호출마다_rpc_server_call_duration_seconds를한번내고_method는등록한이름이나unknown_code는상태이름이다', { timeout: 10_000 }, async () => {
    const metrics = new PlatformMetrics('demo-svc');
    const s = await serve({ metrics });
    const c = client(s.port);
    expect((await call(c, 'Slow', '1')).code).toBe(grpc.status.OK);
    expect((await call(c, 'Slow', 'nf')).code).toBe(grpc.status.NOT_FOUND);
    expect((await call(c, 'Other', '1')).code).toBe(grpc.status.UNIMPLEMENTED);
    const text = await metrics.registry.metrics();
    const count = (labels: Record<string, string>) => sample(text, 'rpc_server_call_duration_seconds_count', { service: 'demo-svc', ...labels });
    expect(count({ method: 'peaket.test.v1.SlowService/Slow', code: 'OK' })).toBe(1);
    expect(count({ method: 'peaket.test.v1.SlowService/Slow', code: 'NOT_FOUND' })).toBe(1);
    expect(count({ method: 'unknown', code: 'UNIMPLEMENTED' })).toBe(1);
    // 등록 밖 메서드 이름을 라벨로 싣지 않는다(라벨 수가 부르는 쪽 마음대로 늘지 않게)
    expect(text).not.toContain('SlowService/Other');
  });
});
