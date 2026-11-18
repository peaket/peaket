// 업무 gRPC 포트 시작과 우아한 종료(BUILD_ORDER BAS-080, docs/devops.md §6.4 ②, D-T27). 서비스 여섯(identity·payment·purchase·queue·ticket·trust)이
// 자기 grpc-server.ts에 두던 같은 꼴을 한 곳으로 모았다(PRF-020·PRF-180이 넘긴 것).
// - 서버 설정은 grpcServerOptions(config.grpcLbProfile): headless-round-robin이면 연결 수명 30초 [가정](FND-100이 넘긴 것)
// - 닫기: 새 호출을 받지 않고(tryShutdown) 처리 중인 호출이 끝나기를 drainMs(기본 10초 [가정]) 기다린다. 넘으면 그때만 끊는다(forceShutdown).
//   호출이 먼저 끝나면 바로 돌아온다
// - 호출마다 rpc_server_call_duration_seconds{service, method, code}를 한 번 낸다(docs/observability.md §3 'gRPC 서버 지표'). 끊긴 호출은 CANCELLED다
// 메시 없는 로컬·CI에서는 평문이다(파드 사이 mTLS는 메시가 맡는다, ADR-0082).
import * as grpc from '@grpc/grpc-js';
import type { GrpcLbProfile } from './config.js';
import { grpcServerOptions } from './grpc-channel.js';
import type { PlatformMetrics } from './metrics.js';

/** 공용 gRPC 서버 기본값 [가정](서비스 여섯의 DRAIN_MS와 같다) */
export const GRPC_SERVER_DEFAULTS = Object.freeze({
  /** 닫을 때 처리 중인 호출을 기다리는 시간(ms). 넘으면 끊는다 */
  drainMs: 10_000,
});

/** 등록한 메서드 밖의 호출을 묶는 method 라벨 */
export const RPC_UNKNOWN_METHOD = 'unknown';

export interface GrpcServiceBinding {
  definition: grpc.ServiceDefinition;
  handlers: grpc.UntypedServiceImplementation;
}

export interface StartGrpcServerOptions {
  host: string;
  /** 0이면 빈 포트를 잡고 돌려준다(시험) */
  port: number;
  services: GrpcServiceBinding[];
  /** 설정의 grpcLbProfile */
  profile: GrpcLbProfile;
  /** 내부 gRPC 공유 토큰 검사(internalGrpcServerInterceptor). token이 없으면 검사하지 않는다(local·ci) */
  internal?: { token?: string; services?: readonly string[] };
  /** 서비스 뼈대의 지표 묶음. 없으면 호출 지표를 내지 않는다 */
  metrics?: PlatformMetrics;
  /** 닫을 때 처리 중인 호출을 기다리는 시간(ms, 기본 GRPC_SERVER_DEFAULTS.drainMs) */
  drainMs?: number;
}

export interface StartedGrpcServer {
  /** 실제로 연 포트 */
  port: number;
  /** 새 호출을 받지 않고 처리 중인 호출을 마감까지 기다린 뒤 닫는다. 두 번 불러도 같은 약속을 돌려준다 */
  close(): Promise<void>;
}

const STATUS_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(grpc.status)
    .filter((e): e is [string, number] => typeof e[1] === 'number')
    .map(([name, code]) => [code, name]),
);
const statusName = (code: number): string => STATUS_NAMES.get(code) ?? 'UNKNOWN';

/** 등록한 메서드의 경로(/peaket.trust.v1.TrustService/ScoreRisk)들 */
function registeredPaths(services: readonly GrpcServiceBinding[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const s of services) for (const m of Object.values(s.definition)) out.add(m.path);
  return out;
}

/**
 * 호출 지표 가로채기. 가로채기 목록의 맨 앞에 두어 바닥 호출 바로 위에 선다: 그 위의 가로채기(내부 토큰 검사)가 보낸 상태도,
 * 바닥에서 올라오는 취소도 이 층을 지난다. 호출 하나에 한 번만 센다(상태를 보냈거나 취소됐거나 먼저 온 것)
 */
function rpcMetricsInterceptor(metrics: PlatformMetrics, paths: ReadonlySet<string>): grpc.ServerInterceptor {
  return (method, call) => {
    const started = performance.now();
    const label = paths.has(method.path) ? method.path.replace(/^\//, '') : RPC_UNKNOWN_METHOD;
    let done = false;
    const record = (code: number) => {
      if (done) return;
      done = true;
      metrics.rpcServerDuration.observe({ service: metrics.service, method: label, code: statusName(code) }, Math.max(0, performance.now() - started) / 1000);
    };
    return new grpc.ServerInterceptingCall(call, {
      start: (next) => {
        next({
          onCancel: () => record(grpc.status.CANCELLED),
        } as grpc.ServerListener);
      },
      sendStatus: (status, next) => {
        record(status.code);
        next(status);
      },
    });
  };
}

/**
 * 등록하지 않은 경로의 호출은 grpc-js가 가로채기를 거치지 않고 UNIMPLEMENTED로 답한다. 그 호출도 method="unknown"으로 세려고
 * 처리기 찾기(@grpc/grpc-js 1.14 Server의 내부 함수 _retrieveHandler)를 감싼다. 그 함수가 없는 판이면 감싸지 않는다(그 호출만 세지 않는다)
 */
function countUnimplemented(server: grpc.Server, metrics: PlatformMetrics): void {
  const target = server as unknown as { _retrieveHandler?: (path: string) => unknown };
  const original = target._retrieveHandler;
  if (typeof original !== 'function') return;
  target._retrieveHandler = function (this: unknown, path: string) {
    const handler: unknown = original.call(this, path);
    if (handler === null || handler === undefined) metrics.rpcServerDuration.observe({ service: metrics.service, method: RPC_UNKNOWN_METHOD, code: 'UNIMPLEMENTED' }, 0);
    return handler;
  };
}

/** 업무 gRPC 포트를 연다. 서비스 사이 gRPC 서버는 이 함수로만 연다(docs/api/guidelines.md §5) */
export async function startGrpcServer(o: StartGrpcServerOptions): Promise<StartedGrpcServer> {
  const drainMs = o.drainMs ?? GRPC_SERVER_DEFAULTS.drainMs;
  if (!(Number.isInteger(drainMs) && drainMs >= 0)) throw new RangeError(`drainMs는 0 이상의 정수(ms)여야 한다: ${String(o.drainMs)}`);
  const options = grpcServerOptions(o.profile, {}, o.internal);
  if (o.metrics) options.interceptors = [rpcMetricsInterceptor(o.metrics, registeredPaths(o.services)), ...(options.interceptors ?? [])];
  const server = new grpc.Server(options);
  if (o.metrics) countUnimplemented(server, o.metrics);
  for (const s of o.services) server.addService(s.definition, s.handlers);
  const port = await new Promise<number>((res, rej) => server.bindAsync(`${o.host}:${o.port}`, grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  let closing: Promise<void> | undefined;
  return {
    port,
    close: () =>
      (closing ??= new Promise<void>((res) => {
        const timer = setTimeout(() => {
          server.forceShutdown();
          res();
        }, drainMs);
        timer.unref();
        server.tryShutdown(() => {
          clearTimeout(timer);
          res();
        });
      })),
  };
}
