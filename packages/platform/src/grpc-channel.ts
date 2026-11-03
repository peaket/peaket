// 서비스 사이 gRPC 채널 생성 함수(ADR-0082 결정 4, docs/api/guidelines.md §5, openspec 변경 add-breakers-purchase-auth-and-grpc-channel 결정 10~12).
// 재시도·헤지 정책을 넣지 않고 grpc.enable_retries를 끄지 않는다(투명 재시도만). 부하 분산은 프로필 하나로 고른다.
// 앱은 데드라인과 추적 머리를 넘기고, 파드 사이 TLS·네트워크 재시도는 메시가 맡는다.
import * as grpc from '@grpc/grpc-js';
import { SpanKind, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import { type Clock, systemClock } from './clock.js';
import { GRPC_LB_PROFILES, type GrpcLbProfile } from './config.js';
import { requestContext } from './context.js';

export { GRPC_LB_PROFILES, type GrpcLbProfile } from './config.js';

/** 덧붙일 설정으로 바꿀 수 없는 채널 이름 */
export const GRPC_CHANNEL_LOCKED = Object.freeze([
  'grpc.enable_retries',
  'grpc.service_config',
  'grpc.service_config_disable_resolution',
  'grpc.use_local_subchannel_pool',
] as const);
/** headless-round-robin의 서버 연결 수명 [가정](정본에 값이 없다). 새 파드가 늘어도 연결이 다시 고르게 퍼지게 한다 */
export const GRPC_HEADLESS_MAX_CONNECTION_AGE_MS = 30_000;
const SERVER_LOCKED = Object.freeze(['grpc.max_connection_age_ms'] as const);
/** 덧붙일 설정에 넣으면 잠근 채널 설정·가로채기를 건너뛰는 클라이언트 선택지(코드 리뷰 2026-11-01) */
const CLIENT_LOCKED = Object.freeze(['channelOverride', 'channelFactoryOverride', 'interceptors', 'interceptor_providers', 'callInvocationTransformer'] as const);

const LB_POLICY: Record<GrpcLbProfile, string> = { service: 'pick_first', 'headless-round-robin': 'round_robin' };
const DEPENDENCY = /^[a-z][a-z0-9-]{0,31}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function profileOf(profile: GrpcLbProfile): GrpcLbProfile {
  if (!(GRPC_LB_PROFILES as readonly string[]).includes(profile)) throw new TypeError(`gRPC 부하 분산 프로필은 ${GRPC_LB_PROFILES.join('·')} 가운데 하나다: ${profile}`);
  return profile;
}

function refuseLocked(extra: grpc.ChannelOptions, locked: readonly string[], what: string): void {
  for (const k of Object.keys(extra)) {
    if (locked.includes(k)) throw new Error(`${what}의 ${k}는 공용 함수가 정한다(덧붙일 설정으로 바꿀 수 없다, ADR-0082)`);
  }
}

/**
 * 채널 설정(결정 10). 서비스 설정에는 부하 분산 방식만 넣는다(retryPolicy·hedgingPolicy 없음). DNS TXT 서비스 설정을 읽지 않아
 * 바깥 설정으로 재시도 정책이 들어오지 않게 하고, 의존성마다 따로 연결을 둔다(벌크헤드). grpc.enable_retries는 넣지 않는다(기본 켬)
 */
export function grpcChannelOptions(profile: GrpcLbProfile, extra: grpc.ChannelOptions = {}): grpc.ChannelOptions {
  const p = profileOf(profile);
  refuseLocked(extra, GRPC_CHANNEL_LOCKED, '채널 설정');
  return {
    ...extra,
    'grpc.service_config': JSON.stringify({ loadBalancingConfig: [{ [LB_POLICY[p]]: {} }] }),
    'grpc.service_config_disable_resolution': 1,
    'grpc.use_local_subchannel_pool': 1,
  };
}

/** 서버 설정. headless-round-robin이면 연결 수명을 둔다(측정 전용 프로필, guidelines §5) */
export function grpcServerOptions(profile: GrpcLbProfile, extra: grpc.ChannelOptions = {}): grpc.ChannelOptions {
  const p = profileOf(profile);
  refuseLocked(extra, SERVER_LOCKED, '서버 설정');
  return p === 'headless-round-robin' ? { ...extra, 'grpc.max_connection_age_ms': GRPC_HEADLESS_MAX_CONNECTION_AGE_MS } : { ...extra };
}

/** dns:///<호스트>:<포트>. service는 Service 이름, headless-round-robin은 헤드리스 Service 이름을 준다 */
export function grpcTarget(host: string, port: number): string {
  if (!HOST.test(host)) throw new TypeError(`gRPC 호스트 이름이 틀렸다: ${host}`);
  if (!(Number.isInteger(port) && port > 0 && port <= 65535)) throw new RangeError(`gRPC 포트가 틀렸다: ${port}`);
  return `dns:///${host}:${port}`;
}

export interface GrpcInterceptorOptions {
  /** 의존성 이름(소문자·숫자·-). span의 peaket.dependency와 정규 로그 줄 dep의 이름 */
  dependency: string;
  /** 한 번 부를 때의 데드라인 상한(ms). 요청 안이면 남은 시간과 짧은 쪽 */
  timeoutCapMs: number;
  clock?: Clock;
}

const tracer = trace.getTracer('@peaket/platform');
const deadlineMs = (d: grpc.Deadline | undefined): number => (d === undefined ? Number.POSITIVE_INFINITY : d instanceof Date ? d.getTime() : d);

/**
 * 호출마다 붙는 가로채기(결정 11): 데드라인 = min(이미 건 값, 지금 + min(남은 시간, 상한)), 호출 span(CLIENT), 추적 머리, dep 소요.
 * OTel gRPC 자동 계측은 쓰지 않는다(같은 호출 span이 둘 생기지 않게)
 */
export function peaketGrpcInterceptor(o: GrpcInterceptorOptions): grpc.Interceptor {
  if (!DEPENDENCY.test(o.dependency)) throw new TypeError(`dependency는 소문자·숫자·-로 된 32자 이하여야 한다: ${o.dependency}`);
  if (!(Number.isInteger(o.timeoutCapMs) && o.timeoutCapMs > 0)) throw new RangeError(`timeoutCapMs는 양의 정수여야 한다: ${o.timeoutCapMs}`);
  const clock = o.clock ?? systemClock;
  return (options, nextCall) => {
    const ctx = requestContext();
    const budget = ctx ? ctx.deadline.budgetFor(o.timeoutCapMs) : o.timeoutCapMs;
    const ours = clock.now() + budget;
    if (ours < deadlineMs(options.deadline)) options.deadline = new Date(ours);
    const path = options.method_definition.path;
    const [service = '', method = ''] = path.replace(/^\//, '').split('/');
    const span = tracer.startSpan(
      `${service}/${method}`,
      { kind: SpanKind.CLIENT, attributes: { 'rpc.system': 'grpc', 'rpc.service': service, 'rpc.method': method, 'peaket.dependency': o.dependency } },
      context.active(),
    );
    const started = clock.monotonicMs();
    let ended = false;
    const end = (code: number) => {
      if (ended) return;
      ended = true;
      span.setAttribute('rpc.grpc.status_code', code);
      if (code !== grpc.status.OK) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      ctx?.log.dependency(o.dependency, Math.max(0, clock.monotonicMs() - started));
    };
    return new grpc.InterceptingCall(nextCall(options), {
      start(metadata, listener, next) {
        propagation.inject(trace.setSpan(context.active(), span), metadata, { set: (m, k, v) => (m as grpc.Metadata).set(k, v) });
        next(metadata, {
          onReceiveStatus(status, nextStatus) {
            end(status.code);
            nextStatus(status);
          },
        });
      },
    });
  };
}

export interface GrpcClientOptions extends GrpcInterceptorOptions {
  /** Service 이름(예 trust-svc.trust.svc.cluster.local) */
  host: string;
  port: number;
  /** 설정의 grpcLbProfile */
  profile: GrpcLbProfile;
  /** 덧붙일 채널 설정(잠긴 이름 제외) */
  extra?: grpc.ChannelOptions;
}

type ClientConstructor<T extends grpc.Client> = new (address: string, credentials: grpc.ChannelCredentials, options?: grpc.ClientOptions) => T;

/**
 * 서비스 사이 gRPC 클라이언트는 이 함수로만 만든다(guidelines §5). 자격 증명은 평문이다(파드 사이 mTLS는 메시가 맡는다).
 * 의존성 호출은 차단기(createCircuitBreaker)로 감싼다
 */
export function createGrpcClient<T extends grpc.Client>(Ctor: ClientConstructor<T>, o: GrpcClientOptions): T {
  const interceptor = peaketGrpcInterceptor(o);
  refuseLocked(o.extra ?? {}, CLIENT_LOCKED, '클라이언트 설정');
  return new Ctor(grpcTarget(o.host, o.port), grpc.credentials.createInsecure(), { ...grpcChannelOptions(o.profile, o.extra), interceptors: [interceptor] });
}
