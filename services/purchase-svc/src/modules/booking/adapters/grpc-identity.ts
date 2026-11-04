// identity-svc gRPC 클라이언트 둘(docs/api/proto/peaket/identity/v1/identity.proto, docs/architecture.md 시간 초과 표, docs/features/payment.md §2 '주문 생성의 첫 구현', BUILD_ORDER PRF-161):
// - IdentityService.GetVerificationStatus(본인확인 재확인, 데드라인 150ms [가정], RESOURCE_EXHAUSTED·INTERNAL·UNKNOWN만 남은 데드라인 안에서 한 번 다시 묻는다)
// - ContactRefService.ComputeContactRef(조사용 연락처 가명, 데드라인 50ms [가정], 다시 묻지 않는다)
// 클라이언트는 플랫폼 createGrpcClient로 만들고(부하 분산 프로필·추적·의존 로그·데드라인 상한), 재확인은 플랫폼 차단기로 감싼다.
// 설명자는 @peaket/contracts/proto의 identityV1Identity다(identity-svc adapters/grpc-merge-checkers.ts와 같은 꼴).
// 주소(PEAKET_IDENTITY_GRPC_ADDR, host:port)가 없으면 로컬·CI만 대역을 쓴다: 재확인은 늘 '답 없음(unavailable)'이라 토큰 판정으로 가고, 가명은 늘 비운다(refMissing 참).
// 그 밖의 환경은 주소 없이 시작하지 않는다(리뷰 고침 M1). 가명 계산은 재확인과 따로인 차단기로 감싼다(M4).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile, ProblemError } from '@peaket/platform';
import type { ContactRefs, IdentityRecheck, IdentityRecheckQuery } from '../domain/ports.js';
import type { RecheckAnswer, RecheckFailure } from '../domain/recheck.js';

/** 주소 환경 값(host:port) */
export const IDENTITY_GRPC_ADDR_ENV = 'PEAKET_IDENTITY_GRPC_ADDR';

/** 의존성 이름(span·의존 로그·차단기 지표) */
const DEPENDENCY = 'identity-svc';
/** 재확인 한 번(다시 묻기 포함)의 데드라인 상한 150ms [가정](architecture 시간 초과 표. 쓰임새 IDENTITY_RECHECK_DEADLINE_MS와 같은 값) */
const RECHECK_CAP_MS = 150;
/** 가명 계산의 데드라인 상한 50ms [가정](architecture 시간 초과 표. 쓰임새 CONTACT_REF_DEADLINE_MS와 같은 값) */
const CONTACT_REF_CAP_MS = 50;

/** 설명자를 읽는 선택지(받는 층과 같은 값: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자, oneof 이름 칸) */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type IdentityPackage = { IdentityService: grpc.ServiceClientConstructor; ContactRefService: grpc.ServiceClientConstructor };

let loaded: IdentityPackage | undefined;
/** identity/v1 패키지 설명자(처음 한 번 읽는다) */
function identityPackage(): IdentityPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: IdentityPackage } } }).peaket.identity.v1;
  }
  return loaded;
}

/** host:port를 나눈다. 모양이 틀리면 Error(시작 실패) */
function hostPortOf(address: string): { host: string; port: number } {
  const at = address.lastIndexOf(':');
  const port = Number(address.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${IDENTITY_GRPC_ADDR_ENV}는 host:port여야 한다`);
  return { host: address.slice(0, at), port };
}

/** gRPC 서비스 오류(grpc-js ServiceError: code·details·metadata) */
function isServiceError(e: unknown): e is grpc.ServiceError {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'number' && 'metadata' in e;
}

/**
 * gRPC 상태 코드 → 재확인 실패 까닭. 다시 물을 까닭(RESOURCE_EXHAUSTED 8·INTERNAL 13·UNKNOWN 2)은 한 번 다시 물은 뒤에도 같으면 이 값이다.
 * DEADLINE_EXCEEDED 4 → deadline, UNAVAILABLE 14 → unavailable, RESOURCE_EXHAUSTED 8 → exhausted, INTERNAL 13·UNKNOWN 2 → internal,
 * PERMISSION_DENIED 7 → permission_denied, INVALID_ARGUMENT 3 → invalid_argument,
 * 그 밖의 코드(UNIMPLEMENTED 12·UNAUTHENTICATED 16·NOT_FOUND 5·FAILED_PRECONDITION 9 등, 정본 목록 밖) → unexpected(대체 판정 없이 503 설정 오류, 리뷰 고침 M2)
 */
export function recheckFailureOf(grpcCode: number): RecheckFailure {
  switch (grpcCode) {
    case grpc.status.DEADLINE_EXCEEDED:
      return 'deadline';
    case grpc.status.UNAVAILABLE:
      return 'unavailable';
    case grpc.status.RESOURCE_EXHAUSTED:
      return 'exhausted';
    case grpc.status.INTERNAL:
    case grpc.status.UNKNOWN:
      return 'internal';
    case grpc.status.PERMISSION_DENIED:
      return 'permission_denied';
    case grpc.status.INVALID_ARGUMENT:
      return 'invalid_argument';
    default:
      return 'unexpected';
  }
}

/**
 * 재확인 호출이 던진 것 → 실패 까닭. 차단기가 부르지 않은 거절(503 dependency-unavailable)은 circuit_open, 요청의 남은 시간이 없어 부르지 않음(504)은 deadline,
 * 동시 호출 상한(429 server-busy)은 exhausted, gRPC 오류는 recheckFailureOf, 그 밖(다른 Problem, gRPC가 아닌 예외)은 unexpected(설정·코드 오류)
 */
function failureOf(e: unknown): RecheckFailure {
  if (e instanceof ProblemError) {
    if (e.slug === 'dependency-unavailable') return 'circuit_open';
    if (e.slug === 'deadline-exceeded') return 'deadline';
    if (e.slug === 'server-busy') return 'exhausted';
    return 'unexpected';
  }
  return isServiceError(e) ? recheckFailureOf(e.code) : 'unexpected';
}

/** 다시 묻는 gRPC 상태 코드(UNKNOWN 2·RESOURCE_EXHAUSTED 8·INTERNAL 13) */
export const RECHECK_RETRY_CODES: ReadonlySet<number> = new Set([2, 8, 13]);

export interface GrpcIdentityOptions {
  /** host:port */
  address: string;
  /** 설정의 grpcLbProfile(기본 service) */
  profile?: GrpcLbProfile;
  /** 재확인 차단기(열려 있으면 부르지 않고 circuit_open). 없으면 차단기 없이 부른다 */
  breaker?: CircuitBreaker;
}

/** 재확인 응답 → 답. verified가 참이 아니면 DENIED(pid 칸은 보지 않는다) */
function answerOf(v: Record<string, unknown>): RecheckAnswer {
  if (v.verified !== true) return { status: 'DENIED' };
  const pid = typeof v.pid === 'string' ? v.pid : '';
  const prev = typeof v.previous_pid === 'string' ? v.previous_pid : '';
  return { status: 'VERIFIED', pid, ...(prev !== '' ? { previousPid: prev } : {}) };
}

/**
 * 재확인 클라이언트. check 차례: 차단기가 열렸으면 { FAILED, circuit_open } → GetVerificationStatus({ account_id, session_id }, 데드라인 = 지금 + q.deadlineMs)
 * → verified 참이면 { VERIFIED, pid, previousPid(빈 글이면 없음) }, 거짓이면 { DENIED } → 오류 코드가 RECHECK_RETRY_CODES이고 남은 데드라인이 있으면 같은 마감 안에서 한 번 더
 * → 그래도 실패면 { FAILED, recheckFailureOf(코드) }. 던지지 않는다.
 * gRPC 오류는 차단기 안에서 던져 차단기가 실패로 센다(플랫폼 isBreakerFailure). 다시 묻는 호출도 차단기를 지난다
 */
export class GrpcIdentityRecheck implements IdentityRecheck {
  readonly #client: grpc.Client & { GetVerificationStatus: Unary };

  constructor(readonly o: GrpcIdentityOptions) {
    const { host, port } = hostPortOf(o.address);
    this.#client = createGrpcClient(identityPackage().IdentityService, {
      host,
      port,
      profile: o.profile ?? 'service',
      dependency: DEPENDENCY,
      timeoutCapMs: RECHECK_CAP_MS,
    }) as unknown as grpc.Client & { GetVerificationStatus: Unary };
  }

  async check(q: IdentityRecheckQuery): Promise<RecheckAnswer> {
    // 한 번 다시 묻는 호출도 처음 마감 안이다(마감은 이 시각 하나)
    const deadlineAt = Date.now() + Math.max(1, Math.floor(q.deadlineMs));
    const request = { account_id: q.accountId, session_id: q.sessionId };
    try {
      return answerOf(await this.#call(request, deadlineAt));
    } catch (first) {
      if (!(isServiceError(first) && RECHECK_RETRY_CODES.has(first.code) && Date.now() < deadlineAt)) return { status: 'FAILED', reason: failureOf(first) };
    }
    try {
      return answerOf(await this.#call(request, deadlineAt));
    } catch (second) {
      return { status: 'FAILED', reason: failureOf(second) };
    }
  }

  /** 호출 하나(차단기가 있으면 그 안에서) */
  #call(request: object, deadlineAt: number): Promise<Record<string, unknown>> {
    const once = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client.GetVerificationStatus(request, new grpc.Metadata(), { deadline: new Date(deadlineAt) }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    return this.o.breaker ? this.o.breaker.run(once) : once();
  }

  close(): void {
    this.#client.close();
  }
}

/**
 * 가명 클라이언트. ComputeContactRef({ phone_e164 }, 데드라인 = 지금 + deadlineMs) 한 번. 오류·빈 contact_ref·차단기 열림이면 undefined. 던지지 않는다.
 * breaker는 재확인과 따로인 차단기다(의존 이름 identity-svc-contact-ref, 리뷰 고침 M4). gRPC 오류는 그 안에서 던져 실패로 센다
 */
export class GrpcContactRefs implements ContactRefs {
  readonly #client: grpc.Client & { ComputeContactRef: Unary };

  constructor(readonly o: GrpcIdentityOptions) {
    const { host, port } = hostPortOf(o.address);
    this.#client = createGrpcClient(identityPackage().ContactRefService, {
      host,
      port,
      profile: o.profile ?? 'service',
      dependency: DEPENDENCY,
      timeoutCapMs: CONTACT_REF_CAP_MS,
    }) as unknown as grpc.Client & { ComputeContactRef: Unary };
  }

  async compute(phoneE164: string, deadlineMs: number): Promise<string | undefined> {
    const deadline = new Date(Date.now() + Math.max(1, Math.floor(deadlineMs)));
    const once = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client.ComputeContactRef({ phone_e164: phoneE164 }, new grpc.Metadata(), { deadline }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    try {
      const v = await (this.o.breaker ? this.o.breaker.run(once) : once());
      const ref = v.contact_ref;
      return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
    } catch {
      // 오류·시간 초과·차단기 열림·닫힌 클라이언트 모두 '받지 못함'이다(refMissing 참)
      return undefined;
    }
  }

  close(): void {
    this.#client.close();
  }
}

/** 주소가 없을 때의 재확인 대역: 늘 { FAILED, unavailable }(토큰 판정으로 간다) */
export const unavailableIdentityRecheck: IdentityRecheck = {
  check: async () => ({ status: 'FAILED', reason: 'unavailable' }),
};

/** 주소가 없을 때의 가명 대역: 늘 undefined(refMissing 참) */
export const missingContactRefs: ContactRefs = {
  compute: async () => undefined,
};

/** 주소 없이 대역으로 뜰 수 있는 환경(로컬·CI). 그 밖(demo·staging·prod)은 주소가 없으면 시작하지 않는다(리뷰 고침 M1) */
const STUB_ENVS: ReadonlySet<string> = new Set(['local', 'ci']);

/**
 * 환경 값으로 두 클라이언트를 만든다. PEAKET_IDENTITY_GRPC_ADDR가 있으면 gRPC 클라이언트(재확인은 o.breaker, 가명은 o.contactRefBreaker로 감싼다),
 * 없으면(빈 글 포함) PEAKET_ENV가 local·ci일 때만 두 대역과 warnings 한 줄(재확인은 토큰 판정, 가명은 비움. 시작 로그에 남겨 빠진 설정을 알아채게 한다).
 * PEAKET_ENV가 없으면 플랫폼 설정(loadPlatformConfig)처럼 prod로 본다
 * @throws Error 주소가 host:port 모양이 아님, 또는 local·ci가 아닌데 주소가 없음(시작 실패). main.ts는 주문 경로를 열 때(purchase DB가 있을 때)만 부른다
 */
export function identityClientsFromEnv(
  env: Record<string, string | undefined>,
  o: { profile?: GrpcLbProfile; breaker?: CircuitBreaker; contactRefBreaker?: CircuitBreaker } = {},
): { recheck: IdentityRecheck; contactRefs: ContactRefs; warnings: string[]; close(): void } {
  const address = (env[IDENTITY_GRPC_ADDR_ENV] ?? '').trim();
  if (address === '') {
    const peaketEnv = env.PEAKET_ENV || 'prod';
    if (!STUB_ENVS.has(peaketEnv)) {
      throw new Error(`${IDENTITY_GRPC_ADDR_ENV}가 없다(주문 생성의 본인확인 재확인·조사용 연락처 가명. 대역은 PEAKET_ENV가 local·ci일 때만 쓴다)`);
    }
    return {
      recheck: unavailableIdentityRecheck,
      contactRefs: missingContactRefs,
      warnings: [`${IDENTITY_GRPC_ADDR_ENV}가 없어 본인확인 재확인은 늘 토큰 판정(대체 판정)으로, 조사용 연락처 가명은 늘 비운 채(refMissing 참)로 둔다`],
      close: () => {},
    };
  }
  const recheck = new GrpcIdentityRecheck({ address, ...(o.profile ? { profile: o.profile } : {}), ...(o.breaker ? { breaker: o.breaker } : {}) });
  const contactRefs = new GrpcContactRefs({ address, ...(o.profile ? { profile: o.profile } : {}), ...(o.contactRefBreaker ? { breaker: o.contactRefBreaker } : {}) });
  return {
    recheck,
    contactRefs,
    warnings: [],
    close: () => {
      recheck.close();
      contactRefs.close();
    },
  };
}
