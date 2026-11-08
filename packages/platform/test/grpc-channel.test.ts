// gRPC 채널 생성 함수(ADR-0082 결정 4, docs/api/guidelines.md §5, openspec 변경 add-breakers-purchase-auth-and-grpc-channel 결정 10~12).
// 실제 grpc-js 서버를 로컬 포트에 띄워 본다(컨테이너 없음).
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { startTelemetry } from '../src/telemetry.js';

const exporter = new InMemorySpanExporter();
const telemetry = startTelemetry({ serviceName: 'grpc-test', version: 't', env: 'ci', spanProcessors: [new SimpleSpanProcessor({ exporter })] });

import * as grpc from '@grpc/grpc-js';
import { SpanKind, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  Deadline,
  GRPC_CHANNEL_LOCKED,
  GRPC_HEADLESS_MAX_CONNECTION_AGE_MS,
  createGrpcClient,
  grpcChannelOptions,
  grpcServerOptions,
  grpcTarget,
  loadPlatformConfig,
  runInRequestContext,
  systemClock,
  type RequestContext,
} from '../src/index.js';

const bytes = { requestSerialize: (b: Buffer) => b, requestDeserialize: (b: Buffer) => b, responseSerialize: (b: Buffer) => b, responseDeserialize: (b: Buffer) => b };
const EchoDef = { Echo: { path: '/peaket.test.v1.EchoService/Echo', requestStream: false, responseStream: false, ...bytes } } as const;
const EchoClient = grpc.makeGenericClientConstructor(EchoDef as unknown as grpc.ServiceDefinition, 'EchoService');
type Echo = grpc.Client & { Echo(req: Buffer, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Buffer) => void): grpc.ClientUnaryCall };

interface Seen {
  deadline: Date | number;
  traceparent?: string;
  at: number;
}

/** 서버 하나. failNext면 다음 호출을 UNAVAILABLE로 끝낸다 */
async function echoServer(name: string) {
  const seen: Seen[] = [];
  const state = { failNext: false };
  const server = new grpc.Server(grpcServerOptions('service'));
  server.addService(EchoDef as unknown as grpc.ServiceDefinition, {
    Echo(call: grpc.ServerUnaryCall<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) {
      seen.push({ deadline: call.getDeadline(), traceparent: call.metadata.get('traceparent')[0] as string | undefined, at: Date.now() });
      if (state.failNext) {
        state.failNext = false;
        cb({ code: grpc.status.UNAVAILABLE, details: 'down' });
        return;
      }
      cb(null, Buffer.from(name));
    },
  });
  const port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  return { name, port, seen, state, server };
}

const unary = (c: Echo, opts: grpc.CallOptions = {}) =>
  new Promise<string>((res, rej) => c.Echo(Buffer.from('x'), new grpc.Metadata(), opts, (e, v) => (e ? rej(e) : res(String(v)))));
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 0;
  } catch (e) {
    return (e as grpc.ServiceError).code;
  }
};

let a: Awaited<ReturnType<typeof echoServer>>;
let b: Awaited<ReturnType<typeof echoServer>>;
const clients: grpc.Client[] = [];
beforeAll(async () => {
  a = await echoServer('a');
  b = await echoServer('b');
});
afterAll(async () => {
  for (const c of clients) c.close();
  a.server.forceShutdown();
  b.server.forceShutdown();
  await telemetry.shutdown();
});

const client = (o: Partial<Parameters<typeof createGrpcClient>[1]> = {}) => {
  const c = createGrpcClient(EchoClient, { dependency: 'echo-svc', host: '127.0.0.1', port: a.port, profile: 'service', timeoutCapMs: 1000, ...o }) as unknown as Echo;
  clients.push(c);
  return c;
};

describe('채널 설정(ADR-0082 결정 4)', () => {
  test('FND100_서비스설정에는_부하분산방식만있고_재시도헤지정책과enable_retries가없다', () => {
    for (const [profile, lb] of [
      ['service', 'pick_first'],
      ['headless-round-robin', 'round_robin'],
    ] as const) {
      const o = grpcChannelOptions(profile);
      const sc = JSON.parse(o['grpc.service_config'] as string) as Record<string, unknown>;
      expect(sc).toEqual({ loadBalancingConfig: [{ [lb]: {} }] });
      expect(JSON.stringify(sc)).not.toMatch(/retryPolicy|hedgingPolicy|methodConfig/);
      expect('grpc.enable_retries' in o).toBe(false);
      expect(o['grpc.service_config_disable_resolution']).toBe(1);
      expect(o['grpc.use_local_subchannel_pool']).toBe(1);
    }
  });

  test('FND100_잠긴이름은_덧붙일설정으로바꿀수없다', () => {
    expect(GRPC_CHANNEL_LOCKED).toEqual(expect.arrayContaining(['grpc.enable_retries', 'grpc.service_config', 'grpc.service_config_disable_resolution', 'grpc.use_local_subchannel_pool']));
    for (const k of GRPC_CHANNEL_LOCKED) expect(() => grpcChannelOptions('service', { [k]: 0 })).toThrow(k);
    expect(grpcChannelOptions('service', { 'grpc.keepalive_time_ms': 30_000 })['grpc.keepalive_time_ms']).toBe(30_000);
    expect(() => grpcChannelOptions('round_robin' as never)).toThrow(/round_robin/);
  });

  test('FND100_서버설정은_headless_round_robin에만_max_connection_age다', () => {
    expect(GRPC_HEADLESS_MAX_CONNECTION_AGE_MS).toBe(30_000);
    expect(grpcServerOptions('headless-round-robin')['grpc.max_connection_age_ms']).toBe(30_000);
    expect('grpc.max_connection_age_ms' in grpcServerOptions('service')).toBe(false);
    expect(() => grpcServerOptions('headless-round-robin', { 'grpc.max_connection_age_ms': 1 })).toThrow(/max_connection_age/);
  });

  test('FND100_주소는_dns_세빗금이고_틀린호스트와포트는거절한다', () => {
    expect(grpcTarget('trust-svc.trust.svc.cluster.local', 50051)).toBe('dns:///trust-svc.trust.svc.cluster.local:50051');
    for (const [h, p] of [
      ['http://x', 1],
      ['a b', 1],
      ['', 1],
      ['x', 0],
      ['x', 70000],
      ['x', 1.5],
    ] as const) {
      expect(() => grpcTarget(h, p)).toThrow();
    }
  });

  test('FND100_PEAKET_GRPC_LB_PROFILE는_기본service이고_headless는_local과ci에서만받는다', () => {
    expect(loadPlatformConfig({ PEAKET_ENV: 'ci' }).grpcLbProfile).toBe('service');
    expect(loadPlatformConfig({ PEAKET_ENV: 'local', PEAKET_GRPC_LB_PROFILE: 'headless-round-robin' }).grpcLbProfile).toBe('headless-round-robin');
    expect(loadPlatformConfig({ PEAKET_ENV: 'ci', PEAKET_GRPC_LB_PROFILE: 'headless-round-robin' }).grpcLbProfile).toBe('headless-round-robin');
    for (const env of ['demo', 'staging', 'prod', undefined]) {
      expect(() => loadPlatformConfig({ PEAKET_ENV: env, PEAKET_GRPC_LB_PROFILE: 'headless-round-robin' })).toThrow(/PEAKET_GRPC_LB_PROFILE/);
    }
    expect(() => loadPlatformConfig({ PEAKET_ENV: 'ci', PEAKET_GRPC_LB_PROFILE: 'round_robin' })).toThrow(/PEAKET_GRPC_LB_PROFILE/);
  });
});

describe('실제 호출', () => {
  test('FND100_서버가UNAVAILABLE로답하면_앱은다시보내지않는다', async () => {
    const c = client();
    const before = a.seen.length;
    a.state.failNext = true;
    expect(await codeOf(unary(c))).toBe(grpc.status.UNAVAILABLE);
    expect(a.seen.length - before).toBe(1);
    await expect(unary(c)).resolves.toBe('a');
  });

  test('FND100_headless_round_robin설정은_두서버에나누고_service설정은한서버에만보낸다', async () => {
    const target = `ipv4:127.0.0.1:${a.port},127.0.0.1:${b.port}`;
    const count = async (profile: 'service' | 'headless-round-robin') => {
      const c = new EchoClient(target, grpc.credentials.createInsecure(), grpcChannelOptions(profile)) as unknown as Echo;
      clients.push(c);
      const got = new Set<string>();
      for (let i = 0; i < 12; i += 1) got.add(await unary(c, { deadline: Date.now() + 2000 }));
      return got;
    };
    expect(await count('headless-round-robin')).toEqual(new Set(['a', 'b']));
    expect((await count('service')).size).toBe(1);
  });

  test('FND100_데드라인은_남은시간과호출상한중짧은쪽이고_이미건값이더짧으면그대로다', async () => {
    const c = client({ timeoutCapMs: 1000 });
    const ctx = (ms: number) =>
      ({ traceId: '0'.repeat(32), deadline: Deadline.after(ms, systemClock), route: '/x', method: 'POST', log: { dependency: vi.fn() } }) as unknown as RequestContext;
    // 기한은 호출이 끝나기 전에 정해진다. 그래서 상한은 끝난 시각에서 재야 러너가 밀려도(CI 42529879827, 323 > 320) 여유 없이 볼 수 있다
    const deadlineOf = async (fn: () => Promise<unknown>) => {
      const t0 = Date.now();
      await fn();
      const t1 = Date.now();
      const d = a.seen.at(-1)!.deadline;
      const at = d instanceof Date ? d.getTime() : d;
      return { fromStart: at - t0, fromEnd: at - t1 };
    };
    const inCtx = await deadlineOf(() => runInRequestContext(ctx(300), () => unary(c)));
    expect(inCtx.fromStart).toBeGreaterThan(0);
    expect(inCtx.fromEnd).toBeLessThanOrEqual(300);
    const noCtx = await deadlineOf(() => unary(c));
    expect(noCtx.fromStart).toBeGreaterThan(300);
    expect(noCtx.fromEnd).toBeLessThanOrEqual(1000);
    const shorter = await deadlineOf(() => runInRequestContext(ctx(5000), () => unary(c, { deadline: Date.now() + 100 })));
    expect(shorter.fromEnd).toBeLessThanOrEqual(100);
  });

  test('FND100_호출span을열고_추적머리를싣고_소요를정규로그줄dep에더한다', async () => {
    const c = client();
    const dependency = vi.fn();
    const ctx = { traceId: '0'.repeat(32), deadline: Deadline.after(2000, systemClock), route: '/x', method: 'POST', log: { dependency } } as unknown as RequestContext;
    exporter.reset();
    await trace.getTracer('t').startActiveSpan('parent', async (parent) => {
      await runInRequestContext(ctx, () => unary(c));
      parent.end();
    });
    const span = exporter.getFinishedSpans().find((s) => s.name === 'peaket.test.v1.EchoService/Echo');
    expect(span).toBeDefined();
    expect(span!.kind).toBe(SpanKind.CLIENT);
    expect(span!.attributes).toMatchObject({ 'rpc.system': 'grpc', 'rpc.service': 'peaket.test.v1.EchoService', 'rpc.method': 'Echo', 'rpc.grpc.status_code': 0, 'peaket.dependency': 'echo-svc' });
    const tp = a.seen.at(-1)!.traceparent;
    expect(tp).toBe(`00-${span!.spanContext().traceId}-${span!.spanContext().spanId}-01`);
    expect(dependency).toHaveBeenCalledWith('echo-svc', expect.any(Number));
  });

  test('FND100_실패한호출은_span상태가오류이고_상태코드를단다', async () => {
    const c = client();
    exporter.reset();
    a.state.failNext = true;
    await codeOf(unary(c));
    const span = exporter.getFinishedSpans().find((s) => s.name === 'peaket.test.v1.EchoService/Echo');
    expect(span!.attributes['rpc.grpc.status_code']).toBe(grpc.status.UNAVAILABLE);
    expect(span!.status.code).toBe(2);
  });

  test('FND100_리뷰_덧붙일설정으로_채널바꿔끼우기와가로채기목록을넣을수없다', () => {
    // 코드 리뷰 2026-11-01: 클라이언트 선택지(channelOverride 등)를 덧붙일 설정에 넣으면 잠근 채널 설정과 가로채기를 건너뛴다
    for (const k of ['channelOverride', 'channelFactoryOverride', 'interceptors', 'interceptor_providers', 'callInvocationTransformer']) {
      expect(() => client({ extra: { [k]: [] } as never })).toThrow(k);
    }
  });

  test('FND100_의존성이름은_소문자이름이어야한다', () => {
    expect(() => client({ dependency: 'Echo Svc' })).toThrow(/dependency/);
  });
});
