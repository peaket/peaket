// identity-svc gRPC 클라이언트 둘(booking GrpcIdentityRecheck·GrpcContactRefs·identityClientsFromEnv)을 루프백의 가짜 gRPC 서버로 돈다(BUILD_ORDER PRF-161, P-T35·P-T52의 클라이언트 쪽).
// 정본: docs/api/proto/peaket/identity/v1/identity.proto(IdentityService.GetVerificationStatus, ContactRefService.ComputeContactRef),
// docs/features/payment.md §2 '주문 생성의 첫 구현' 본인확인 재확인·ComputeContactRef, ADR-0055, booking adapters/grpc-identity.ts의 설명.
//
// 약속:
// - 가짜 서버는 실제 @grpc/grpc-js Server에 계약 설명자(@peaket/contracts/proto의 identityV1Identity)를 실어 띄운다(identity-svc test/identity.grpc.test.ts와 같은 적재 옵션).
// - gRPC 데드라인은 벽시계라 이 파일은 가짜 시계를 쓰지 않는다. 지연은 서버가 답을 미뤄 만들고, 걸린 시간은 넉넉한 상한으로만 본다.
// - 서버의 답은 시험마다 plan으로 정한다(호출 차례대로 하나씩 꺼내고 마지막 것을 되풀이). 받은 요청과 데드라인을 calls에 적는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { CircuitBreaker } from '@peaket/platform';
import { identityV1Identity } from '@peaket/contracts/proto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  GrpcContactRefs,
  GrpcIdentityRecheck,
  IDENTITY_GRPC_ADDR_ENV,
  identityClientsFromEnv,
  missingContactRefs,
  RECHECK_RETRY_CODES,
  recheckFailureOf,
  unavailableIdentityRecheck,
  type RecheckAnswer,
} from '../src/modules/booking/index.js';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Pkg = { IdentityService: grpc.ServiceClientConstructor; ContactRefService: grpc.ServiceClientConstructor };
const pkg = (() => {
  const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], LOAD);
  return (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Pkg } } }).peaket.identity.v1;
})();

/** 서버 답 하나: delayMs 뒤에 error(gRPC 상태 코드) 또는 reply */
interface Step {
  delayMs?: number;
  code?: grpc.status;
  reply?: Record<string, unknown>;
}
interface Call {
  request: Record<string, unknown>;
  /** 받은 시각(Date.now)과 호출의 데드라인(epoch ms, 없으면 Infinity) */
  at: number;
  deadlineMs: number;
}
const plan: { recheck: Step[]; contact: Step[] } = { recheck: [], contact: [] };
const calls: { recheck: Call[]; contact: Call[] } = { recheck: [], contact: [] };

function handler(which: 'recheck' | 'contact'): grpc.handleUnaryCall<Record<string, unknown>, Record<string, unknown>> {
  return (call, callback) => {
    const d = call.getDeadline();
    const deadlineMs = d instanceof Date ? d.getTime() : Number(d);
    calls[which].push({ request: { ...call.request }, at: Date.now(), deadlineMs });
    const steps = plan[which];
    const step = (steps.length > 1 ? steps.shift() : steps[0]) ?? {};
    const answer = () => {
      if (step.code !== undefined) callback({ code: step.code, details: `가짜 ${grpc.status[step.code]}`, metadata: new grpc.Metadata(), name: 'Error', message: 'x' } as grpc.ServiceError);
      else callback(null, step.reply ?? {});
    };
    if (step.delayMs) setTimeout(answer, step.delayMs);
    else answer();
  };
}

let server: grpc.Server;
let address: string;
/** 아무도 듣지 않는 주소(서버를 띄웠다 닫은 포트) */
let deadAddress: string;

const bind = (s: grpc.Server) =>
  new Promise<number>((res, rej) => s.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, port) => (e ? rej(e) : res(port))));

beforeAll(async () => {
  server = new grpc.Server();
  server.addService(pkg.IdentityService.service, { GetVerificationStatus: handler('recheck') });
  server.addService(pkg.ContactRefService.service, { ComputeContactRef: handler('contact') });
  address = `127.0.0.1:${await bind(server)}`;
  const dead = new grpc.Server();
  deadAddress = `127.0.0.1:${await bind(dead)}`;
  await new Promise<void>((r) => dead.tryShutdown(() => r()));
});

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.tryShutdown(() => r()) : r()));
});

beforeEach(() => {
  plan.recheck = [];
  plan.contact = [];
  calls.recheck.length = 0;
  calls.contact.length = 0;
});

const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a1';
const LOGIN = '0190f3a1-7c2e-7a00-8000-00000000f001';
const PHONE = '+821012345678';

/** 클라이언트를 만들어 fn을 돌리고 닫는다 */
async function withRecheck<T>(fn: (c: GrpcIdentityRecheck) => Promise<T>, o: { addr?: string; breaker?: CircuitBreaker } = {}): Promise<T> {
  const c = new GrpcIdentityRecheck({ address: o.addr ?? address, ...(o.breaker ? { breaker: o.breaker } : {}) });
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}
async function withContact<T>(fn: (c: GrpcContactRefs) => Promise<T>, addr = address): Promise<T> {
  const c = new GrpcContactRefs({ address: addr });
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

const ask = (c: GrpcIdentityRecheck, deadlineMs = 150) => c.check({ accountId: ACCOUNT, sessionId: LOGIN, deadlineMs });
const failed = (reason: string): RecheckAnswer => ({ status: 'FAILED', reason } as RecheckAnswer);

describe('recheckFailureOf(gRPC 상태 코드 → 재확인 실패 까닭)', () => {
  test.each<[number, string]>([
    [grpc.status.DEADLINE_EXCEEDED, 'deadline'],
    [grpc.status.UNAVAILABLE, 'unavailable'],
    [grpc.status.RESOURCE_EXHAUSTED, 'exhausted'],
    [grpc.status.INTERNAL, 'internal'],
    [grpc.status.UNKNOWN, 'internal'],
    [grpc.status.PERMISSION_DENIED, 'permission_denied'],
    [grpc.status.INVALID_ARGUMENT, 'invalid_argument'],
    // 정본 목록 밖의 코드는 대체 판정 없이 503 설정 오류 쪽이다(리뷰 고침 M2 2026-11-05)
    [grpc.status.NOT_FOUND, 'unexpected'],
    [grpc.status.UNAUTHENTICATED, 'unexpected'],
    [grpc.status.UNIMPLEMENTED, 'unexpected'],
    [grpc.status.FAILED_PRECONDITION, 'unexpected'],
    [grpc.status.DATA_LOSS, 'unexpected'],
  ])('코드 %i → %s', (code, reason) => {
    expect(recheckFailureOf(code)).toBe(reason);
  });

  test('다시 묻는 코드는 UNKNOWN 2·RESOURCE_EXHAUSTED 8·INTERNAL 13 셋이다', () => {
    expect([...RECHECK_RETRY_CODES].sort((a, b) => a - b)).toEqual([2, 8, 13]);
  });
});

describe('GrpcIdentityRecheck.check(IdentityService.GetVerificationStatus)', () => {
  test('PT35_verified 참이면 VERIFIED와 pid이고, previous_pid가 빈 글이면 previousPid 칸이 없다. 요청은 account_id·session_id, 데드라인은 지금 + deadlineMs다', async () => {
    plan.recheck = [{ reply: { verified: true, pid: 'pid-now', previous_pid: '' } }];
    const r = await withRecheck((c) => ask(c, 150));
    expect(r).toEqual({ status: 'VERIFIED', pid: 'pid-now' });
    expect(r).not.toHaveProperty('previousPid');
    expect(calls.recheck).toHaveLength(1);
    expect(calls.recheck[0]!.request).toMatchObject({ account_id: ACCOUNT, session_id: LOGIN });
    const left = calls.recheck[0]!.deadlineMs - calls.recheck[0]!.at;
    expect(Number.isFinite(left)).toBe(true);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(150 + 20);
  });

  test('PT35_pid 키 전환 중이면 previous_pid를 previousPid로 싣는다', async () => {
    plan.recheck = [{ reply: { verified: true, pid: 'pid-new', previous_pid: 'pid-old' } }];
    expect(await withRecheck((c) => ask(c))).toEqual({ status: 'VERIFIED', pid: 'pid-new', previousPid: 'pid-old' });
  });

  test("PT35_verified 거짓('무효')이면 DENIED이고 다시 묻지 않는다", async () => {
    plan.recheck = [{ reply: { verified: false, pid: '', previous_pid: '' } }];
    expect(await withRecheck((c) => ask(c))).toEqual({ status: 'DENIED' });
    expect(calls.recheck).toHaveLength(1);
  });

  test('PT35_데드라인 안에 답이 없으면 FAILED deadline이고 다시 묻지 않으며, 데드라인 뒤 곧 돌아온다', async () => {
    plan.recheck = [{ delayMs: 600, reply: { verified: true, pid: 'late' } }];
    const started = Date.now();
    const r = await withRecheck((c) => ask(c, 100));
    expect(r).toEqual(failed('deadline'));
    expect(Date.now() - started).toBeLessThan(450);
    expect(calls.recheck).toHaveLength(1);
  });

  test.each<[string, grpc.status, string]>([
    ['UNAVAILABLE', grpc.status.UNAVAILABLE, 'unavailable'],
    ['PERMISSION_DENIED', grpc.status.PERMISSION_DENIED, 'permission_denied'],
    ['INVALID_ARGUMENT', grpc.status.INVALID_ARGUMENT, 'invalid_argument'],
    ['NOT_FOUND(그 밖의 코드)', grpc.status.NOT_FOUND, 'unexpected'],
    ['UNIMPLEMENTED(그 밖의 코드)', grpc.status.UNIMPLEMENTED, 'unexpected'],
    ['UNAUTHENTICATED(그 밖의 코드)', grpc.status.UNAUTHENTICATED, 'unexpected'],
    ['FAILED_PRECONDITION(그 밖의 코드)', grpc.status.FAILED_PRECONDITION, 'unexpected'],
  ])('PT35_%s는 다시 묻지 않고 바로 FAILED %s다', async (_label, code, reason) => {
    plan.recheck = [{ code }];
    expect(await withRecheck((c) => ask(c))).toEqual(failed(reason));
    expect(calls.recheck).toHaveLength(1);
  });

  test.each<[string, grpc.status, string]>([
    ['RESOURCE_EXHAUSTED', grpc.status.RESOURCE_EXHAUSTED, 'exhausted'],
    ['INTERNAL', grpc.status.INTERNAL, 'internal'],
    ['UNKNOWN', grpc.status.UNKNOWN, 'internal'],
  ])('PT35_%s는 남은 데드라인 안에서 한 번 다시 묻고, 그래도 같으면 FAILED %s다(호출 둘)', async (_label, code, reason) => {
    plan.recheck = [{ code }];
    expect(await withRecheck((c) => ask(c))).toEqual(failed(reason));
    expect(calls.recheck).toHaveLength(2);
    expect(calls.recheck[1]!.request).toEqual(calls.recheck[0]!.request);
  });

  test('PT35_RESOURCE_EXHAUSTED 뒤 다시 물어 답을 받으면 그 답(VERIFIED)이다. 다시 묻는 호출도 처음 마감 안이다(데드라인이 늘지 않는다)', async () => {
    plan.recheck = [{ code: grpc.status.RESOURCE_EXHAUSTED }, { reply: { verified: true, pid: 'pid-2', previous_pid: '' } }];
    const started = Date.now();
    expect(await withRecheck((c) => ask(c, 150))).toEqual({ status: 'VERIFIED', pid: 'pid-2' });
    expect(calls.recheck).toHaveLength(2);
    expect(calls.recheck[1]!.deadlineMs).toBeLessThanOrEqual(started + 150 + 20);
  });

  test('PT35_INTERNAL 뒤 다시 물어 verified 거짓이면 DENIED다', async () => {
    plan.recheck = [{ code: grpc.status.INTERNAL }, { reply: { verified: false } }];
    expect(await withRecheck((c) => ask(c))).toEqual({ status: 'DENIED' });
    expect(calls.recheck).toHaveLength(2);
  });

  test('PT35_서버가 없으면(듣는 곳 없는 주소) 던지지 않고 FAILED unavailable이다', async () => {
    const r = await withRecheck((c) => ask(c, 150), { addr: deadAddress });
    expect(r).toEqual(failed('unavailable'));
  });

  // 정본 모호: 차단기를 여는 실패의 셈은 플랫폼 차단기(isBreakerFailure)가 한다. 어댑터가 gRPC 오류를 차단기 안에서 던져(셈에 넣고) 밖에서 FAILED로 바꾼다고 가정한다
  test('PT35_차단기가 열려 있으면 부르지 않고 FAILED circuit_open이다(실패가 쌓여 열린 뒤)', async () => {
    const breaker = new CircuitBreaker({ service: 'purchase-svc', dependency: 'identity-svc', minCalls: 1, failureRatePercent: 50, openMs: 60_000 });
    try {
      plan.recheck = [{ code: grpc.status.UNAVAILABLE }];
      await withRecheck(
        async (c) => {
          for (let i = 0; i < 10 && breaker.state !== 'open'; i += 1) expect((await ask(c)).status).toBe('FAILED');
          expect(breaker.state).toBe('open');
          const before = calls.recheck.length;
          expect(await ask(c)).toEqual(failed('circuit_open'));
          expect(calls.recheck).toHaveLength(before);
        },
        { breaker },
      );
    } finally {
      breaker.shutdown();
    }
  });
});

describe('GrpcContactRefs.compute(ContactRefService.ComputeContactRef)', () => {
  test('PT52_E.164 번호를 phone_e164로 보내고 contact_ref를 그대로 돌려준다. 데드라인은 지금 + deadlineMs다', async () => {
    plan.contact = [{ reply: { contact_ref: 'k1.Zk3QpL0-contact' } }];
    expect(await withContact((c) => c.compute(PHONE, 50))).toBe('k1.Zk3QpL0-contact');
    expect(calls.contact).toHaveLength(1);
    expect(calls.contact[0]!.request).toEqual({ phone_e164: PHONE });
    const left = calls.contact[0]!.deadlineMs - calls.contact[0]!.at;
    expect(Number.isFinite(left)).toBe(true);
    expect(left).toBeLessThanOrEqual(50 + 20);
  });

  test('PT52_50ms를 넘겨 답하면 undefined이고 다시 묻지 않는다(곧 돌아온다)', async () => {
    plan.contact = [{ delayMs: 400, reply: { contact_ref: 'k1.late' } }];
    const started = Date.now();
    expect(await withContact((c) => c.compute(PHONE, 50))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(350);
    expect(calls.contact).toHaveLength(1);
  });

  test.each<[string, grpc.status]>([
    ['UNAVAILABLE', grpc.status.UNAVAILABLE],
    ['RESOURCE_EXHAUSTED(요청 상한)', grpc.status.RESOURCE_EXHAUSTED],
    ['INTERNAL', grpc.status.INTERNAL],
    ['PERMISSION_DENIED', grpc.status.PERMISSION_DENIED],
    ['INVALID_ARGUMENT', grpc.status.INVALID_ARGUMENT],
  ])('PT52_%s 오류면 undefined이고 다시 묻지 않는다(던지지 않는다)', async (_label, code) => {
    plan.contact = [{ code }];
    expect(await withContact((c) => c.compute(PHONE, 50))).toBeUndefined();
    expect(calls.contact).toHaveLength(1);
  });

  test('PT52_빈 contact_ref는 undefined다', async () => {
    plan.contact = [{ reply: { contact_ref: '' } }];
    expect(await withContact((c) => c.compute(PHONE, 50))).toBeUndefined();
  });

  test('PT52_서버가 없으면 undefined다', async () => {
    expect(await withContact((c) => c.compute(PHONE, 50), deadAddress)).toBeUndefined();
  });

  // 리뷰 고침 M4(2026-11-05): 가명 계산은 재확인과 따로인 차단기(의존 이름 identity-svc-contact-ref)로 감싼다
  test('PT52_가명 차단기는 실패(UNAVAILABLE)가 쌓이면 열리고, 열린 뒤에는 서버를 부르지 않고 undefined다. 재확인 차단기와 따로다', async () => {
    const contactBreaker = new CircuitBreaker({ service: 'purchase-svc', dependency: 'identity-svc-contact-ref', minCalls: 1, failureRatePercent: 50, openMs: 60_000 });
    const recheckBreaker = new CircuitBreaker({ service: 'purchase-svc', dependency: 'identity-svc', minCalls: 1, failureRatePercent: 50, openMs: 60_000 });
    const contact = new GrpcContactRefs({ address, breaker: contactBreaker });
    const recheck = new GrpcIdentityRecheck({ address, breaker: recheckBreaker });
    try {
      plan.contact = [{ code: grpc.status.UNAVAILABLE }];
      expect(await contact.compute(PHONE, 50)).toBeUndefined();
      expect(contactBreaker.state).toBe('open');
      const before = calls.contact.length;
      expect(await contact.compute(PHONE, 50)).toBeUndefined();
      expect(calls.contact).toHaveLength(before);
      // 재확인 차단기는 닫힌 채 그대로 부른다
      plan.recheck = [{ reply: { verified: true, pid: 'pid-x', previous_pid: '' } }];
      expect(await recheck.check({ accountId: ACCOUNT, sessionId: LOGIN, deadlineMs: 150 })).toEqual({ status: 'VERIFIED', pid: 'pid-x' });
      expect(recheckBreaker.state).toBe('closed');
    } finally {
      contact.close();
      recheck.close();
      contactBreaker.shutdown();
      recheckBreaker.shutdown();
    }
  });
});

describe('identityClientsFromEnv', () => {
  // 리뷰 고침 M1(2026-11-05): 대역은 PEAKET_ENV가 local·ci일 때만이다. 값이 없으면 플랫폼(loadPlatformConfig)처럼 prod로 보고 던진다
  test(`로컬·CI에서 주소(${IDENTITY_GRPC_ADDR_ENV})가 없으면 두 대역과 경고 한 줄: 재확인은 늘 FAILED unavailable(토큰 판정으로 간다), 가명은 늘 undefined다. 서버를 부르지 않는다`, async () => {
    const c = identityClientsFromEnv({ PEAKET_ENV: 'ci' });
    try {
      expect(await c.recheck.check({ accountId: ACCOUNT, sessionId: LOGIN, deadlineMs: 150 })).toEqual(failed('unavailable'));
      expect(await c.contactRefs.compute(PHONE, 50)).toBeUndefined();
      expect(c.warnings).toHaveLength(1);
      // 가정: 경고는 빠진 설정 이름을 담는다(시작 로그에서 알아채게)
      expect(c.warnings[0]).toContain(IDENTITY_GRPC_ADDR_ENV);
      expect(calls.recheck).toEqual([]);
      expect(calls.contact).toEqual([]);
    } finally {
      c.close();
    }
  });

  // 정본 모호: 빈 글 주소를 '없음'으로 볼지 적혀 있지 않다. 비밀 관리가 빈 값을 넣는 경우도 대역으로 간다고 가정한다
  test('ASVS16.5.3_운영·데모·스테이징(그리고 PEAKET_ENV 없음)에서 주소가 없거나 빈 글이면 대역으로 뜨지 않고 던진다(시작 실패) [ASVS v5.0.0-16.5.3]', () => {
    for (const env of [{ PEAKET_ENV: 'prod' }, { PEAKET_ENV: 'demo' }, { PEAKET_ENV: 'staging' }, {}]) {
      expect(() => identityClientsFromEnv(env)).toThrow(new RegExp(IDENTITY_GRPC_ADDR_ENV));
      expect(() => identityClientsFromEnv({ ...env, [IDENTITY_GRPC_ADDR_ENV]: '' })).toThrow(new RegExp(IDENTITY_GRPC_ADDR_ENV));
    }
  });

  test('로컬에서 주소가 빈 글이어도 대역이다', async () => {
    const c = identityClientsFromEnv({ PEAKET_ENV: 'local', [IDENTITY_GRPC_ADDR_ENV]: '' });
    try {
      expect(await c.recheck.check({ accountId: ACCOUNT, sessionId: LOGIN, deadlineMs: 150 })).toEqual(failed('unavailable'));
      expect(await c.contactRefs.compute(PHONE, 50)).toBeUndefined();
      expect(c.warnings).toHaveLength(1);
    } finally {
      c.close();
    }
  });

  test('주소가 있으면 그 서버로 부르는 두 클라이언트이고 경고가 없다', async () => {
    plan.recheck = [{ reply: { verified: true, pid: 'pid-env', previous_pid: '' } }];
    plan.contact = [{ reply: { contact_ref: 'k1.env' } }];
    const c = identityClientsFromEnv({ PEAKET_ENV: 'prod', [IDENTITY_GRPC_ADDR_ENV]: address });
    try {
      expect(c.warnings).toEqual([]);
      expect(await c.recheck.check({ accountId: ACCOUNT, sessionId: LOGIN, deadlineMs: 150 })).toEqual({ status: 'VERIFIED', pid: 'pid-env' });
      expect(await c.contactRefs.compute(PHONE, 50)).toBe('k1.env');
      expect(calls.recheck).toHaveLength(1);
      expect(calls.contact).toHaveLength(1);
    } finally {
      c.close();
    }
  });

  test('대역 둘은 따로 써도 같다: unavailableIdentityRecheck는 FAILED unavailable, missingContactRefs는 undefined', async () => {
    expect(await unavailableIdentityRecheck.check({ accountId: ACCOUNT, sessionId: LOGIN, deadlineMs: 150 })).toEqual(failed('unavailable'));
    expect(await missingContactRefs.compute(PHONE, 50)).toBeUndefined();
  });
});
