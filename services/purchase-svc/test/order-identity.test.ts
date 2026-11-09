// identity-svc gRPC 클라이언트(booking adapters/grpc-identity.ts)의 단위 시험(BUILD_ORDER PRF-161 리뷰 고침 2026-11-05).
// - M1 identityClientsFromEnv: 주소가 없을 때 대역은 PEAKET_ENV가 local·ci일 때만, 그 밖(운영·데모·스테이징, 값이 없으면 플랫폼처럼 prod)은 던진다(시작 실패)
// - M2 recheckFailureOf 코드 대응 표, 정본 목록 밖의 gRPC 코드·gRPC가 아닌 예외는 unexpected(쓰임새가 503 설정 오류), 차단기의 503·429·504
// - M4 가명 계산의 차단기(재확인과 따로, 의존 이름 identity-svc-contact-ref)
// 실제 gRPC 서버로 도는 것은 test-int/identity-grpc.int.test.ts다. 여기서는 서버를 부르지 않는다(가짜 차단기가 호출을 막는다).
import { CircuitBreaker, deadlineExceeded, dependencyUnavailable, serverBusy } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  GrpcContactRefs,
  GrpcIdentityRecheck,
  IDENTITY_GRPC_ADDR_ENV,
  identityClientsFromEnv,
  judgeRecheck,
  missingContactRefs,
  type RecheckFailure,
  recheckFailureOf,
  unavailableIdentityRecheck,
} from '../src/modules/booking/index.js';

const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a1';
const Q = { accountId: ACCOUNT, sessionId: 'ls-1', deadlineMs: 150 };
/** 아무도 부르지 않는 주소(가짜 차단기가 호출 전에 끊는다) */
const ADDR = '127.0.0.1:9';

/** run이 action을 부르지 않고 err를 던지는 가짜 차단기 */
const refusing = (err: unknown) => ({ run: async () => Promise.reject(err), calls: 0 }) as unknown as CircuitBreaker;

describe('M1 identityClientsFromEnv: 주소가 없을 때', () => {
  test.each(['local', 'ci'])('PEAKET_ENV=%s면 대역 둘과 경고 한 줄이다(빠진 설정 이름을 담는다)', async (env) => {
    for (const addr of [undefined, '', '  ']) {
      const c = identityClientsFromEnv({ PEAKET_ENV: env, [IDENTITY_GRPC_ADDR_ENV]: addr });
      expect(c.recheck).toBe(unavailableIdentityRecheck);
      expect(c.contactRefs).toBe(missingContactRefs);
      expect(c.warnings).toHaveLength(1);
      expect(c.warnings[0]).toContain(IDENTITY_GRPC_ADDR_ENV);
      c.close();
    }
  });

  test.each(['prod', 'demo', 'staging', undefined, ''])('PEAKET_ENV=%j(값이 없으면 플랫폼처럼 prod)면 주소 없이 대역으로 뜨지 않고 던진다(시작 실패) [ASVS v5.0.0-16.5.3]', (env) => {
    for (const addr of [undefined, '']) {
      expect(() => identityClientsFromEnv({ ...(env === undefined ? {} : { PEAKET_ENV: env }), [IDENTITY_GRPC_ADDR_ENV]: addr })).toThrow(new RegExp(IDENTITY_GRPC_ADDR_ENV));
    }
  });

  test('주소가 있으면 어느 환경이든 gRPC 클라이언트 둘이고 경고가 없다. 두 차단기를 각 클라이언트에 따로 넘긴다', () => {
    const breaker = refusing(new Error('x'));
    const contactRefBreaker = refusing(new Error('y'));
    const c = identityClientsFromEnv({ PEAKET_ENV: 'prod', [IDENTITY_GRPC_ADDR_ENV]: ADDR }, { breaker, contactRefBreaker });
    try {
      expect(c.warnings).toEqual([]);
      expect(c.recheck).toBeInstanceOf(GrpcIdentityRecheck);
      expect(c.contactRefs).toBeInstanceOf(GrpcContactRefs);
      expect((c.recheck as GrpcIdentityRecheck).o.breaker).toBe(breaker);
      expect((c.contactRefs as GrpcContactRefs).o.breaker).toBe(contactRefBreaker);
    } finally {
      c.close();
    }
  });

  test('주소가 host:port 모양이 아니면 던진다(시작 실패)', () => {
    for (const addr of ['identity-svc', ':50051', 'identity-svc:0', 'identity-svc:x']) expect(() => identityClientsFromEnv({ PEAKET_ENV: 'ci', [IDENTITY_GRPC_ADDR_ENV]: addr })).toThrow(Error);
  });
});

describe('M2 recheckFailureOf(gRPC 상태 코드 → 까닭) 대응 표', () => {
  const TABLE: [number, string, RecheckFailure][] = [
    [7, 'PERMISSION_DENIED', 'permission_denied'],
    [3, 'INVALID_ARGUMENT', 'invalid_argument'],
    [4, 'DEADLINE_EXCEEDED', 'deadline'],
    [14, 'UNAVAILABLE', 'unavailable'],
    [8, 'RESOURCE_EXHAUSTED', 'exhausted'],
    [13, 'INTERNAL', 'internal'],
    [2, 'UNKNOWN', 'internal'],
    [12, 'UNIMPLEMENTED', 'unexpected'],
    [16, 'UNAUTHENTICATED', 'unexpected'],
    [5, 'NOT_FOUND', 'unexpected'],
    [9, 'FAILED_PRECONDITION', 'unexpected'],
    [1, 'CANCELLED', 'unexpected'],
    [6, 'ALREADY_EXISTS', 'unexpected'],
    [10, 'ABORTED', 'unexpected'],
    [11, 'OUT_OF_RANGE', 'unexpected'],
    [15, 'DATA_LOSS', 'unexpected'],
    [99, '모르는 코드', 'unexpected'],
  ];

  test.each(TABLE)('PT35_코드 %i(%s) → %s', (code, _name, reason) => {
    expect(recheckFailureOf(code)).toBe(reason);
  });

  test('PT35_대체 판정(토큰 판정)으로 가는 것은 차단기 열림·4·14(바로)와 8·13·2(다시 물은 뒤)뿐이고, 7·3·그 밖의 코드는 토큰이 있어도 MISCONFIGURED다 [ASVS v5.0.0-16.5.3]', () => {
    const token = { pid: 'pid-1', scopes: ['ticket:buy'] };
    for (const [code, name, reason] of TABLE) {
      const kind = judgeRecheck({ status: 'FAILED', reason }, token).kind;
      expect({ code, name, kind }).toEqual({ code, name, kind: [4, 14, 8, 13, 2].includes(code) ? 'PASS_FALLBACK' : 'MISCONFIGURED' });
    }
    expect(judgeRecheck({ status: 'FAILED', reason: 'circuit_open' }, token).kind).toBe('PASS_FALLBACK');
  });
});

describe('M2 GrpcIdentityRecheck: 차단기 거절과 gRPC가 아닌 예외', () => {
  test.each<[string, unknown, RecheckFailure]>([
    ['차단기 열림(503 dependency-unavailable)', dependencyUnavailable(5), 'circuit_open'],
    ['요청의 남은 시간 없음(504 deadline-exceeded)', deadlineExceeded(), 'deadline'],
    ['동시 호출 상한(429 server-busy)', serverBusy(), 'exhausted'],
    ['gRPC가 아닌 예외(TypeError)', new TypeError('Cannot read properties of undefined'), 'unexpected'],
    ['그 밖의 Error', new Error('serialize failed'), 'unexpected'],
    ['Error가 아닌 값', 'weird', 'unexpected'],
  ])('PT35_%s → FAILED %s(던지지 않는다)', async (_label, err, reason) => {
    const c = new GrpcIdentityRecheck({ address: ADDR, breaker: refusing(err) });
    try {
      expect(await c.check(Q)).toEqual({ status: 'FAILED', reason });
    } finally {
      c.close();
    }
  });
});

describe('M4 GrpcContactRefs: 가명 계산의 차단기', () => {
  test('PT52_차단기가 열려 있으면(503) 부르지 않고 undefined다(던지지 않는다)', async () => {
    const runs: unknown[] = [];
    const breaker = {
      // 부를 일(action)을 받기만 하고 부르지 않는다(열린 차단기)
      run: async (action: unknown) => {
        runs.push(action);
        throw dependencyUnavailable(5);
      },
    } as unknown as CircuitBreaker;
    const c = new GrpcContactRefs({ address: ADDR, breaker });
    try {
      expect(await c.compute('+821012345678', 50)).toBeUndefined();
      expect(runs).toHaveLength(1);
    } finally {
      c.close();
    }
  });

  test('PT52_가명 계산은 차단기 안에서 부른다: 실패가 차단기에 실패로 세어져 열리고, 열린 뒤에는 부르지 않는다(의존 이름 identity-svc-contact-ref)', async () => {
    const breaker = new CircuitBreaker({ service: 'purchase-svc', dependency: 'identity-svc-contact-ref', minCalls: 1, failureRatePercent: 50, openMs: 60_000 });
    // 듣는 서버가 없는 루프백 포트: UNAVAILABLE(차단기 실패로 센다)
    const c = new GrpcContactRefs({ address: '127.0.0.1:1', breaker });
    try {
      expect(breaker.dependency).toBe('identity-svc-contact-ref');
      expect(await c.compute('+821012345678', 200)).toBeUndefined();
      expect(breaker.state).toBe('open');
      expect(await c.compute('+821012345678', 200)).toBeUndefined();
      expect(breaker.inFlight).toBe(0);
    } finally {
      c.close();
      breaker.shutdown();
    }
  });
});
