// gRPC ReverificationCheckService.CheckReverification(docs/api/proto identity.proto, docs/features/bot-defense.md §5.2 3단계,
// docs/features/identity.md I-T56, BUILD_ORDER BOT-090, ADR-0259). 추가 검증 제출에서 queue-svc가 부른다.
// 실제 grpc-js 서버를 루프백에 띄우고 계약 설명자로 만든 클라이언트로 부른다. 재확인 기록은 본인확인 시작·결과 확정 유스케이스로 만든다
// (사람 대조를 하는 결과 경로를 그대로 지나야 '사람 대조를 뺀 판'을 잡는다, BAT-200 계획 §5.1 3·4번).
import * as grpc from '@grpc/grpc-js';
import { type FakeClock, fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { identityPackage } from '../src/modules/session/inbound/session.grpc.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import type { TestAgencyOutcome } from '../src/modules/verification/adapters/test-agency.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { CheckReverification } from '../src/modules/verification/application/check-reverification.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { PidRotation } from '../src/modules/verification/application/pid-rotation.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { VerificationError } from '../src/modules/verification/application/verification-error.js';
import type { IdentityHashers, VerificationStore } from '../src/modules/verification/domain/ports.js';
import { reverificationCheckHandlers } from '../src/modules/verification/inbound/reverification.grpc.js';
import { agencyResult, kit, newKey, noClosure, testAgency } from './support.js';

type Cb<T> = (e: grpc.ServiceError | null, v?: T) => void;
type Client = grpc.Client & { CheckReverification(req: Record<string, unknown>, md: grpc.Metadata, opts: grpc.CallOptions, cb: Cb<Record<string, unknown>>): void };
type CheckStore = Pick<VerificationStore, 'claimsOf' | 'reverificationSince'>;

const PASSED = 'REVERIFICATION_RESULT_PASSED';
const NOT_FOUND = 'REVERIFICATION_RESULT_NOT_FOUND';
const PERSON_MISMATCH = 'REVERIFICATION_RESULT_PERSON_MISMATCH';
/** 모양이 맞는 남의 pid(base64url 43자) */
const STRANGER_PID = Buffer.alloc(32, 9).toString('base64url');

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

/** 그 확인 유스케이스를 실제 gRPC 서버에 싣고 계약 설명자 클라이언트를 준다 */
async function serve(check: CheckReverification) {
  const errors: { method: string; err: unknown }[] = [];
  const server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: identityPackage().ReverificationCheckService.service, handlers: reverificationCheckHandlers({ check }, (method, err) => errors.push({ method, err })) }],
  });
  const client = new (identityPackage().ReverificationCheckService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
  closers.push(async () => {
    client.close();
    await server.close();
  });
  const call = (req: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((res, rej) => client.CheckReverification(req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))));
  return { call, errors };
}

const failure = async (p: Promise<unknown>): Promise<{ code: string; details: string }> => {
  try {
    await p;
    return { code: 'OK', details: '' };
  } catch (e) {
    const err = e as grpc.ServiceError;
    return { code: grpc.status[err.code] ?? String(err.code), details: err.details };
  }
};

let people = 0;

/** 본인확인 저장소(메모리), 시작·확정 유스케이스, 확인 서버 */
async function setup(o: { hashers?: IdentityHashers; clock?: FakeClock } = {}) {
  const clock = o.clock ?? fakeClock({ now: Date.parse('2026-11-10T03:00:00.000Z') });
  const verifications = new MemoryVerificationStore();
  const k = await kit(new MemorySessionStore(), { claims: new VerificationClaims(verifications), clock });
  const provider = testAgency(clock);
  const hashers = o.hashers ?? HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const start = new StartVerification(verifications, provider, noClosure, clock);
  const confirmWith = (h: IdentityHashers) => new ConfirmVerification(verifications, provider, h, noClosure, clock);
  const { call, errors } = await serve(new CheckReverification(verifications));

  /** 결과 값을 확정한다. 업무 오류(409 등)는 그 코드를 준다 */
  const settle = async (accountId: string, verificationId: string, r: { person?: string; outcome?: TestAgencyOutcome; birth?: string }, h: IdentityHashers = hashers): Promise<string> => {
    try {
      return (await confirmWith(h).run({ accountId, verificationId, providerResult: agencyResult(clock, verificationId, { ...r }) })).status;
    } catch (e) {
      if (e instanceof VerificationError) return e.code;
      throw e;
    }
  };
  /** 처음 본인확인까지 마친 계정 */
  const verifiedAccount = async (person: string) => {
    const s = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `rv-${people++}`, email: null, deviceId: null });
    const st = await start.run({ accountId: s.accountId, sessionId: s.sessionId, purpose: 'FIRST', next: '/' });
    expect(await settle(s.accountId, st.verificationId, { person })).toBe('VERIFIED');
    return { accountId: s.accountId, sessionId: s.sessionId, pid: (await verifications.claimsOf(s.accountId))!.pid };
  };
  /** 추가 검증 화면이 여는 목적 REVERIFY 창을 시작하고 그 결과를 확정한다 */
  const reverify = async (a: { accountId: string; sessionId: string }, r: { person?: string; outcome?: TestAgencyOutcome; birth?: string }, h?: IdentityHashers) => {
    const st = await start.run({ accountId: a.accountId, sessionId: a.sessionId, purpose: 'REVERIFY', next: '/queue/verify' });
    return settle(a.accountId, st.verificationId, r, h);
  };
  const check = (accountId: string, pid: string, notBeforeMs: number) => call({ account_id: accountId, pid, not_before_ms: notBeforeMs });
  return { clock, verifications, start, settle, verifiedAccount, reverify, check, call, errors };
}

describe('ReverificationCheckService(gRPC)', () => {
  test('I-T56 ① 추가 검증 시작 뒤 같은 사람으로 확정된 재확인은 PASSED와 확정 시각이다', async () => {
    const t = await setup();
    const a = await t.verifiedAccount('han');
    t.clock.advance(60_000);
    const notBefore = t.clock.now();
    t.clock.advance(45_000);
    expect(await t.reverify(a, { person: 'han' })).toBe('VERIFIED');
    const first = t.clock.now();
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PASSED, verified_at_ms: first });
    // 시작 뒤 여러 번 마쳤으면 가장 늦은 확정 시각이다
    t.clock.advance(7_000);
    expect(await t.reverify(a, { person: 'han' })).toBe('VERIFIED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PASSED, verified_at_ms: t.clock.now() });
    expect(t.errors).toEqual([]);
  });

  test('I-T56 ① 시작 전에 연 재확인 창이라도 시작 뒤에 확정했으면 PASSED다(확정 시각으로 센다)', async () => {
    const t = await setup();
    const a = await t.verifiedAccount('lee');
    const st = await t.start.run({ accountId: a.accountId, sessionId: a.sessionId, purpose: 'REVERIFY', next: '/queue/verify' });
    t.clock.advance(5_000);
    const notBefore = t.clock.now();
    // 창은 열렸지만 아직 확정하지 않았다
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    t.clock.advance(5_000);
    expect(await t.settle(a.accountId, st.verificationId, { person: 'lee' })).toBe('VERIFIED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PASSED, verified_at_ms: t.clock.now() });
  });

  test('I-T56 ① 다른 사람 시도가 있어도 시작 뒤 같은 사람으로 확정하면 PASSED다', async () => {
    const t = await setup();
    const a = await t.verifiedAccount('min');
    const notBefore = t.clock.now();
    t.clock.advance(1_000);
    expect(await t.reverify(a, { person: 'other-min' })).toBe('FAILED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toMatchObject({ result: PERSON_MISMATCH });
    t.clock.advance(1_000);
    expect(await t.reverify(a, { person: 'min' })).toBe('VERIFIED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PASSED, verified_at_ms: t.clock.now() });
  });

  test('I-T56 ① 그 계정과 그 pid의 REVERIFY 확정만 센다: 다른 계정·남의 pid·목적 FIRST는 NOT_FOUND다', async () => {
    const t = await setup();
    const a = await t.verifiedAccount('kang');
    const notBefore = t.clock.now();
    t.clock.advance(2_000);
    // 시작 뒤에 처음 본인확인(FIRST)만 한 계정: 재확인이 아니다
    const b = await t.verifiedAccount('park');
    expect(await t.check(b.accountId, b.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    t.clock.advance(2_000);
    expect(await t.reverify(a, { person: 'kang' })).toBe('VERIFIED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toMatchObject({ result: PASSED });
    // a의 재확인은 b의 재통과가 아니다
    expect(await t.check(b.accountId, b.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    // 계정과 pid가 다른 사람의 것이면(사람 대조를 뺀 요청) 재확인 기록이 있어도 재통과가 아니다
    expect(await t.check(a.accountId, b.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    expect(await t.check(b.accountId, a.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    expect(await t.check(a.accountId, STRANGER_PID, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    // 본인확인 기록이 없는 계정
    expect(await t.check('0190f3a1-7c2e-7a00-8000-0000000000aa', a.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    // 계정 ID는 대소문자를 가리지 않는다(같은 계정)
    expect(await t.check(a.accountId.toUpperCase(), a.pid, notBefore)).toMatchObject({ result: PASSED });
  });

  test('I-T56 ① 확정되지 않은 재확인(진행 중·취소·실패·기관 장애)은 NOT_FOUND다', async () => {
    const t = await setup();
    const a = await t.verifiedAccount('song');
    const notBefore = t.clock.now();
    t.clock.advance(1_000);
    await t.start.run({ accountId: a.accountId, sessionId: a.sessionId, purpose: 'REVERIFY', next: '/queue/verify' });
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    expect(await t.reverify(a, { outcome: 'CANCELLED' })).toBe('CANCELLED');
    expect(await t.reverify(a, { outcome: 'FAILED' })).toBe('FAILED');
    expect(await t.reverify(a, { outcome: 'DOWN' })).toBe('PROVIDER_DOWN');
    // 생년월일이 없는 결과는 나이를 확인할 수 없어 FAILED지만 다른 사람이라고 보지 않는다
    expect(await t.reverify(a, { person: 'song', birth: undefined })).toBe('FAILED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
  });

  test('I-T56 ① pid 키 전환 기간에는 옛 pid로 물어도 새 pid로 물어도 같은 사람의 재확인을 찾는다', async () => {
    const ciKeys = new Map([[1, Buffer.alloc(32, 1)]]);
    const h9 = new HmacIdentityHashers({ ciKeys, pidKey: Buffer.alloc(32, 41), pidVersion: 9 });
    const h10 = new HmacIdentityHashers({ ciKeys, pidKey: Buffer.alloc(32, 42), pidVersion: 10 });
    const t = await setup({ hashers: h9 });
    const a = await t.verifiedAccount('jung');
    await new PidRotation(t.verifications, h10, t.clock).start({ until: t.clock.now() + 2 * 86_400_000 });
    const claims = (await t.verifications.claimsOf(a.accountId))!;
    expect(claims.pidPrev).toBe(a.pid);
    expect(claims.pid).not.toBe(a.pid);
    const notBefore = t.clock.now();
    t.clock.advance(3_000);
    expect(await t.reverify(a, { person: 'jung' }, h10)).toBe('VERIFIED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PASSED, verified_at_ms: t.clock.now() });
    expect(await t.check(a.accountId, claims.pid, notBefore)).toEqual({ result: PASSED, verified_at_ms: t.clock.now() });
    expect(await t.check(a.accountId, STRANGER_PID, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
  });

  test('I-T56 ② 시작 전에만 있는 재확인은 NOT_FOUND다(경계: not_before_ms와 같은 시각·1ms 앞)', async () => {
    const t = await setup();
    const a = await t.verifiedAccount('yoon');
    t.clock.advance(30_000);
    expect(await t.reverify(a, { person: 'yoon' })).toBe('VERIFIED');
    const at = t.clock.now();
    // 재확인이 시작 시각보다 1ms 앞이다
    expect(await t.check(a.accountId, a.pid, at + 1)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    // 9분 앞(고위험 재인증의 10분 창 안이어도 추가 검증에는 세지 않는다)
    expect(await t.check(a.accountId, a.pid, at + 9 * 60_000)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    // 시작 시각과 같은 시각의 확정은 센다(not_before: 그 앞이 아님)
    expect(await t.check(a.accountId, a.pid, at)).toEqual({ result: PASSED, verified_at_ms: at });
    expect(await t.check(a.accountId, a.pid, at - 1)).toEqual({ result: PASSED, verified_at_ms: at });
  });

  test('I-T56 ② 시작 전의 다른 사람 결과도 세지 않아 NOT_FOUND다(경계 같은 시각은 센다)', async () => {
    const t = await setup();
    const a = await t.verifiedAccount('jang');
    t.clock.advance(30_000);
    expect(await t.reverify(a, { person: 'not-jang' })).toBe('FAILED');
    const at = t.clock.now();
    expect(await t.check(a.accountId, a.pid, at + 1)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
    expect(await t.check(a.accountId, a.pid, at)).toEqual({ result: PERSON_MISMATCH, verified_at_ms: 0 });
  });

  test('I-T56 ③ 다른 사람의 재확인은 PERSON_MISMATCH다', async () => {
    const t = await setup();
    const a = await t.verifiedAccount('han-3');
    const notBefore = t.clock.now();
    t.clock.advance(20_000);
    // 다른 사람의 휴대폰으로 재확인했다: 결과 경로가 계정에 저장된 ci_hmac과 대조해 FAILED로 마친다
    expect(await t.reverify(a, { person: 'oh-3' })).toBe('FAILED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PERSON_MISMATCH, verified_at_ms: 0 });
  });

  test('I-T56 ③ 다른 계정에서 본인확인한 사람의 재확인도 PERSON_MISMATCH다(DUPLICATE_ACCOUNT)', async () => {
    const t = await setup();
    const a = await t.verifiedAccount('ko');
    const b = await t.verifiedAccount('nam');
    const notBefore = t.clock.now();
    t.clock.advance(1_000);
    expect(await t.reverify(a, { person: 'nam' })).toBe('DUPLICATE_ACCOUNT');
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PERSON_MISMATCH, verified_at_ms: 0 });
    // 결과의 주인인 b 계정의 재통과도 아니다
    expect(await t.check(b.accountId, b.pid, notBefore)).toEqual({ result: NOT_FOUND, verified_at_ms: 0 });
  });

  test('I-T56 ③ 본인확인한 계정의 재확인에서 만 14세 미만이 나오면 다른 사람이라 PERSON_MISMATCH다', async () => {
    const t = await setup();
    const a = await t.verifiedAccount('seo');
    const notBefore = t.clock.now();
    t.clock.advance(1_000);
    expect(await t.reverify(a, { person: 'seo-kid', birth: '2016-05-05' })).toBe('FAILED');
    expect(await t.check(a.accountId, a.pid, notBefore)).toEqual({ result: PERSON_MISMATCH, verified_at_ms: 0 });
  });
});

describe('ReverificationCheckService(gRPC) 요청 모양과 장애', () => {
  /** 부른 횟수를 세는 저장소. reads가 정해 준 대로 답하거나 던진다 */
  function countingStore(o: { claims?: CheckStore['claimsOf']; since?: CheckStore['reverificationSince'] } = {}) {
    const calls = { claimsOf: 0, reverificationSince: 0 };
    const store: CheckStore = {
      claimsOf: async (id) => {
        calls.claimsOf++;
        return o.claims ? o.claims(id) : { pid: STRANGER_PID };
      },
      reverificationSince: async (id, nb) => {
        calls.reverificationSince++;
        return o.since ? o.since(id, nb) : { lastVerifiedAt: 1, personMismatch: false };
      },
    };
    return { store, calls };
  }
  const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000bb';

  test('CheckReverification은 모양이 틀린 요청에 INVALID_ARGUMENT로 답하고 저장소를 읽지 않으며 받은 값을 오류 문구에 싣지 않는다', async () => {
    const { store, calls } = countingStore();
    const { call, errors } = await serve(new CheckReverification(store as VerificationStore));
    const nb = Date.parse('2026-11-10T03:00:00.000Z');
    const bad: Record<string, unknown>[] = [
      {},
      { account_id: 'not-a-uuid<script>', pid: STRANGER_PID, not_before_ms: nb },
      { account_id: '', pid: STRANGER_PID, not_before_ms: nb },
      { account_id: ACCOUNT, pid: '', not_before_ms: nb },
      { account_id: ACCOUNT, pid: 'short-pid-value', not_before_ms: nb },
      { account_id: ACCOUNT, pid: `${STRANGER_PID}=`, not_before_ms: nb },
      { account_id: ACCOUNT, pid: `${STRANGER_PID.slice(0, 42)}+`, not_before_ms: nb },
      // not_before_ms를 넣지 않으면(0) 모든 지난 재확인을 세게 되므로 받지 않는다
      { account_id: ACCOUNT, pid: STRANGER_PID },
      { account_id: ACCOUNT, pid: STRANGER_PID, not_before_ms: 0 },
      { account_id: ACCOUNT, pid: STRANGER_PID, not_before_ms: -5 },
      { account_id: ACCOUNT, pid: STRANGER_PID, not_before_ms: 2 ** 60 },
    ];
    for (const req of bad) {
      const f = await failure(call(req));
      expect(f.code, JSON.stringify(req)).toBe('INVALID_ARGUMENT');
      expect(f.details).not.toContain('<script>');
      expect(f.details).not.toContain('short-pid-value');
      expect(f.details).not.toContain(STRANGER_PID.slice(0, 20));
      expect(f.details).not.toContain(ACCOUNT);
    }
    expect(calls).toEqual({ claimsOf: 0, reverificationSince: 0 });
    expect(errors).toEqual([]);
  });

  test('CheckReverification은 저장소에 닿지 못하면 UNAVAILABLE이고 PASSED로 답하지 않는다', async () => {
    const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    // 재확인 기록 읽기에서 끊긴다(계정 대조는 지났다)
    const late = countingStore({
      since: async () => {
        throw refused();
      },
    });
    const s1 = await serve(new CheckReverification(late.store as VerificationStore));
    const f1 = await failure(s1.call({ account_id: ACCOUNT, pid: STRANGER_PID, not_before_ms: 1_000 }));
    expect(f1).toEqual({ code: 'UNAVAILABLE', details: '지금 처리할 수 없다' });
    // 끊김이 실제로 있었다(읽기까지 닿았다)
    expect(late.calls).toEqual({ claimsOf: 1, reverificationSince: 1 });
    expect(s1.errors.map((e) => e.method)).toEqual(['CheckReverification']);
    // 계정 대조 읽기에서 끊긴다(드라이버가 감싼 연결 끊김 57P01도 같다)
    const early = countingStore({
      claims: async () => {
        throw Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }) });
      },
    });
    const s2 = await serve(new CheckReverification(early.store as VerificationStore));
    expect(await failure(s2.call({ account_id: ACCOUNT, pid: STRANGER_PID, not_before_ms: 1_000 }))).toEqual({ code: 'UNAVAILABLE', details: '지금 처리할 수 없다' });
    expect(early.calls).toEqual({ claimsOf: 1, reverificationSince: 0 });
  });

  test('CheckReverification은 예상하지 못한 오류에 고정 문구의 INTERNAL로 답하고 받은 값을 싣지 않는다', async () => {
    const odd = countingStore({
      since: async (id) => {
        throw new Error(`예상 못 한 오류 ${id} ${STRANGER_PID}`);
      },
    });
    const s = await serve(new CheckReverification(odd.store as VerificationStore));
    const f = await failure(s.call({ account_id: ACCOUNT, pid: STRANGER_PID, not_before_ms: 1_000 }));
    expect(f).toEqual({ code: 'INTERNAL', details: '처리하지 못했다' });
    expect(odd.calls.reverificationSince).toBe(1);
    expect(s.errors.map((e) => e.method)).toEqual(['CheckReverification']);
  });
});
