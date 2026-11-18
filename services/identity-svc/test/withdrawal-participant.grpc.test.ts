// 탈퇴 참여자 클라이언트(adapters/grpc-withdrawal-participants.ts)를 루프백의 가짜 purchase-svc WithdrawalParticipantService로 돈다
// (docs/features/identity.md §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현' '참여자 호출', docs/api/proto/peaket/purchase/v1/account.proto, ADR-0284 결정 1·3, I-T84 ③⑦, BAT-010 시험 담당).
//
// 약속:
// - 가짜 서버는 실제 @grpc/grpc-js Server에 계약 설명자(@peaket/contracts/proto의 purchaseV1Account)를 실어 띄운다. 답은 시험마다 plan으로 정한다.
// - gRPC 데드라인은 벽시계라 서버가 받은 데드라인(epoch ms) − 받은 시각으로 본다. 값은 정본(요청 경로 3초, 고리 10초)에서 적는다.
// - 응용 층(WithdrawAccount·RetryPendingWithdrawals)은 메모리 저장소로 잇고 시계는 가짜다(데드라인 길이는 시계와 따로다).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { createCircuitBreaker, fakeClock } from '@peaket/platform';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GrpcWithdrawalParticipant, withdrawalParticipantsFromEnv } from '../src/modules/session/adapters/grpc-withdrawal-participants.js';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { RetryPendingWithdrawals } from '../src/modules/session/application/retry-pending-withdrawals.js';
import { WithdrawAccount } from '../src/modules/session/application/withdraw-account.js';
import { WithdrawalParticipantUnavailable, type WithdrawalParticipant } from '../src/modules/session/domain/withdrawal.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { VerificationEraser } from '../src/modules/verification/adapters/verification-eraser.js';
import { ISSUER, kit, newKey } from './support.js';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Pkg = { WithdrawalParticipantService: grpc.ServiceClientConstructor };
const pkg = (() => {
  const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], LOAD);
  return (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: Pkg } } }).peaket.purchase.v1;
})();

const REQUEST_DEADLINE_MS = 3_000;
const RETRY_DEADLINE_MS = 10_000;
const TOKEN = 'bat010-internal-grpc-token';

interface Step {
  delayMs?: number;
  code?: grpc.status;
  reply?: Record<string, unknown>;
}
interface Seen {
  request: Record<string, unknown>;
  at: number;
  deadlineMs: number;
  token: unknown;
  caller: unknown;
}
const plan: Step[] = [];
const seen: Seen[] = [];

let server: grpc.Server;
let address: string;
let deadAddress: string;

const bind = (s: grpc.Server) => new Promise<number>((res, rej) => s.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, port) => (e ? rej(e) : res(port))));

beforeAll(async () => {
  server = new grpc.Server();
  server.addService(pkg.WithdrawalParticipantService.service, {
    ProcessAccountWithdrawal: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      const d = call.getDeadline();
      seen.push({ request: { ...call.request }, at: Date.now(), deadlineMs: d instanceof Date ? d.getTime() : Number(d), token: call.metadata.get('x-peaket-internal-grpc-token')[0], caller: call.metadata.get('x-peaket-internal-grpc-caller')[0] });
      const step = (plan.length > 1 ? plan.shift() : plan[0]) ?? { reply: { state: 'WITHDRAWAL_PARTICIPANT_STATE_DONE' } };
      const answer = () => {
        if (step.code !== undefined) cb({ code: step.code, details: `가짜 ${grpc.status[step.code]}`, metadata: new grpc.Metadata(), name: 'Error', message: 'x' } as grpc.ServiceError);
        else cb(null, step.reply ?? {});
      };
      if (step.delayMs) setTimeout(answer, step.delayMs);
      else answer();
    },
  });
  address = `127.0.0.1:${await bind(server)}`;
  const dead = new grpc.Server();
  deadAddress = `127.0.0.1:${await bind(dead)}`;
  await new Promise<void>((r) => dead.tryShutdown(() => r()));
});

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.tryShutdown(() => r()) : r()));
});

beforeEach(() => {
  plan.length = 0;
  seen.length = 0;
  vi.stubEnv('PEAKET_INTERNAL_GRPC_TOKEN', TOKEN);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000084b1';
const clients: GrpcWithdrawalParticipant[] = [];
const client = (o: { address?: string; breaker?: { run: <T>(fn: () => Promise<T>) => Promise<T> } } = {}) => {
  const c = new GrpcWithdrawalParticipant({ address: o.address ?? address, ...(o.breaker ? { breaker: o.breaker as never } : {}) });
  clients.push(c);
  return c;
};
afterAll(() => {
  for (const c of clients) c.close();
});
const rejection = async (p: Promise<unknown>): Promise<unknown> => p.then(() => 'RESOLVED', (e: unknown) => e);

describe('GrpcWithdrawalParticipant.process(I-T84 ③)', () => {
  test('I-T84③_DONE이면DONE이고_요청은그계정ID·내부토큰·부르는쪽identity-svc를싣는다_데드라인은받은deadlineMs다', async () => {
    plan.push({ reply: { state: 'WITHDRAWAL_PARTICIPANT_STATE_DONE' } });
    expect(await client().process(ACCOUNT, { deadlineMs: 1_700 })).toEqual({ state: 'DONE' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.request).toMatchObject({ account_id: ACCOUNT });
    expect(seen[0]!.token).toBe(TOKEN);
    expect(seen[0]!.caller).toBe('identity-svc');
    const left = seen[0]!.deadlineMs - seen[0]!.at;
    expect(left).toBeGreaterThan(1_200);
    expect(left).toBeLessThanOrEqual(1_700);
  });

  test('I-T84③_PENDING이면이유둘을purchase이름(PAYMENT_PENDING_ORDER·DEPOSIT_CANCEL_PENDING)으로준다', async () => {
    plan.push({ reply: { state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: ['WITHDRAWAL_PENDING_REASON_PAYMENT_PENDING_ORDER', 'WITHDRAWAL_PENDING_REASON_DEPOSIT_CANCEL_PENDING'], payment_pending_orders: 1, deposit_orders_pending: 1 } });
    expect(await client().process(ACCOUNT, { deadlineMs: 2_000 })).toEqual({ state: 'PENDING', reasons: ['PAYMENT_PENDING_ORDER', 'DEPOSIT_CANCEL_PENDING'] });
  });

  test.each<[string, grpc.status]>([
    ['UNAVAILABLE', grpc.status.UNAVAILABLE],
    ['INVALID_ARGUMENT', grpc.status.INVALID_ARGUMENT],
    ['INTERNAL', grpc.status.INTERNAL],
    ['UNAUTHENTICATED', grpc.status.UNAUTHENTICATED],
    ['PERMISSION_DENIED', grpc.status.PERMISSION_DENIED],
  ])('I-T84③_gRPC 오류 %s는 DONE으로 접지 않고 WithdrawalParticipantUnavailable이다', async (_name, code) => {
    plan.push({ code });
    const e = await rejection(client().process(ACCOUNT, { deadlineMs: 2_000 }));
    expect(e).toBeInstanceOf(WithdrawalParticipantUnavailable);
    expect(seen).toHaveLength(1);
  });

  test('I-T84③_데드라인안에답이없으면(DEADLINE_EXCEEDED)_WithdrawalParticipantUnavailable이고곧돌아온다', async () => {
    plan.push({ delayMs: 900, reply: { state: 'WITHDRAWAL_PARTICIPANT_STATE_DONE' } });
    const started = Date.now();
    const e = await rejection(client().process(ACCOUNT, { deadlineMs: 150 }));
    expect(e).toBeInstanceOf(WithdrawalParticipantUnavailable);
    expect(Date.now() - started).toBeLessThan(800);
  });

  test('I-T84③_서버가없으면(듣는곳없는주소)_WithdrawalParticipantUnavailable이다', async () => {
    expect(await rejection(client({ address: deadAddress }).process(ACCOUNT, { deadlineMs: 500 }))).toBeInstanceOf(WithdrawalParticipantUnavailable);
  });

  test.each<[string, Record<string, unknown>]>([
    ['state UNSPECIFIED', { state: 'WITHDRAWAL_PARTICIPANT_STATE_UNSPECIFIED' }],
    ['state 없음(기본값)', {}],
    ['모르는 state 값(7)', { state: 7 }],
    ['PENDING에 모르는 이유(UNSPECIFIED)', { state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: ['WITHDRAWAL_PENDING_REASON_UNSPECIFIED'] }],
    ['PENDING에 모르는 이유 값(9)', { state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: ['WITHDRAWAL_PENDING_REASON_PAYMENT_PENDING_ORDER', 9] }],
  ])('I-T84③_답이 %s이면 DONE으로 접지 않고 WithdrawalParticipantUnavailable이다', async (_name, reply) => {
    plan.push({ reply });
    expect(await rejection(client().process(ACCOUNT, { deadlineMs: 2_000 }))).toBeInstanceOf(WithdrawalParticipantUnavailable);
  });

  test('I-T84③_차단기가열렸으면부르지않고WithdrawalParticipantUnavailable이다', async () => {
    const breaker = createCircuitBreaker({ service: 'identity-svc', dependency: 'purchase-svc', minCalls: 1, buckets: 1, failureRatePercent: 1, openMs: 60_000 });
    // 실패 한 번으로 연다
    await breaker.run(() => Promise.reject(new Error('주입한 장애'))).catch(() => undefined);
    plan.push({ reply: { state: 'WITHDRAWAL_PARTICIPANT_STATE_DONE' } });
    expect(await rejection(client({ breaker }).process(ACCOUNT, { deadlineMs: 2_000 }))).toBeInstanceOf(WithdrawalParticipantUnavailable);
    expect(seen).toEqual([]);
  });
});

// ---- 응용 층과 이어 부를 때의 데드라인과 202(I-T84 ③) ----

async function app(participants: WithdrawalParticipant[]) {
  const clock = fakeClock({ now: Date.parse('2026-11-18T11:07:41.903Z') });
  const sessions = new MemorySessionStore();
  const k = await kit(sessions, { clock });
  const eraser = new VerificationEraser(new MemoryVerificationStore());
  const withdraw = new WithdrawAccount(sessions, new JoseReauthVerifier(k.keys, ISSUER, clock), eraser, clock, undefined, undefined, undefined, participants);
  const retry = new RetryPendingWithdrawals(sessions, eraser, clock, participants);
  const login = (id: string) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: id, email: null, deviceId: null });
  const reauth = async (s: { accountId: string; sessionId: string }) => (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, clock.now())).token;
  const run = async (s: { accountId: string; sessionId: string }) => withdraw.run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: await reauth(s), body: {} });
  return { clock, sessions, withdraw, retry, login, run };
}

describe('참여자 호출의 데드라인(요청 경로 3초·고리 10초)과 실패의 202', () => {
  test('I-T84③_요청경로는서버가받은데드라인이3초이고_고리는10초다', async () => {
    const t = await app([client()]);
    const s = await t.login('dl-1');
    plan.push({ reply: { state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: ['WITHDRAWAL_PENDING_REASON_PAYMENT_PENDING_ORDER'] } });
    expect(await t.run(s)).toEqual({ outcome: 'DEFERRED' });
    const req = seen[0]!.deadlineMs - seen[0]!.at;
    expect(req).toBeGreaterThan(REQUEST_DEADLINE_MS - 500);
    expect(req).toBeLessThanOrEqual(REQUEST_DEADLINE_MS);
    expect(seen[0]!.request).toMatchObject({ account_id: s.accountId });
    t.clock.advance(60_000);
    await t.retry.run();
    expect(seen).toHaveLength(2);
    const retry = seen[1]!.deadlineMs - seen[1]!.at;
    expect(retry).toBeGreaterThan(RETRY_DEADLINE_MS - 500);
    expect(retry).toBeLessThanOrEqual(RETRY_DEADLINE_MS);
  });

  test('I-T84③_참여자호출이UNAVAILABLE·DEADLINE_EXCEEDED·INVALID_ARGUMENT·INTERNAL이거나_답이UNSPECIFIED·모르는이유면_204가아니라202(DEFERRED)이고미룸상태다', async () => {
    const steps: Array<[string, Step]> = [
      ['UNAVAILABLE', { code: grpc.status.UNAVAILABLE }],
      ['DEADLINE_EXCEEDED', { code: grpc.status.DEADLINE_EXCEEDED }],
      ['INVALID_ARGUMENT', { code: grpc.status.INVALID_ARGUMENT }],
      ['INTERNAL', { code: grpc.status.INTERNAL }],
      ['UNSPECIFIED', { reply: { state: 'WITHDRAWAL_PARTICIPANT_STATE_UNSPECIFIED' } }],
      ['unknown-reason', { reply: { state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: [9] } }],
    ];
    for (const [name, step] of steps) {
      const t = await app([client()]);
      const s = await t.login(`fail-${name}`);
      plan.length = 0;
      plan.push(step);
      expect({ name, r: await t.run(s) }).toEqual({ name, r: { outcome: 'DEFERRED' } });
      expect(t.sessions.accountOf(s.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'WITHDRAWAL' });
      expect(t.sessions.activeCount(s.accountId)).toBe(1);
    }
  });

  test('I-T84③_서버가늦게답해요청경로3초를넘기면_202다(늦은DONE으로끝내지않는다)', async () => {
    const t = await app([client()]);
    const s = await t.login('late-1');
    plan.push({ delayMs: REQUEST_DEADLINE_MS + 600, reply: { state: 'WITHDRAWAL_PARTICIPANT_STATE_DONE' } });
    const started = Date.now();
    expect(await t.run(s)).toEqual({ outcome: 'DEFERRED' });
    expect(Date.now() - started).toBeLessThan(REQUEST_DEADLINE_MS + 500);
    expect(t.sessions.accountOf(s.accountId)?.status).toBe('WITHDRAWAL_PENDING');
  }, 15_000);
});

describe('withdrawalParticipantsFromEnv(주소가 없을 때, I-T84 ⑦)', () => {
  test.each(['local', 'ci'])('I-T84⑦_%s에서 주소(PEAKET_PURCHASE_GRPC_URL)가 없으면 참여자 없이 끝낸다(늘 DONE 대역, 경고 한 줄): 탈퇴는 204(WITHDRAWN)다', async (env) => {
    const r = withdrawalParticipantsFromEnv({ PEAKET_ENV: env });
    expect(r.participants).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    expect(await r.participants[0]!.process(ACCOUNT, { deadlineMs: 100 })).toEqual({ state: 'DONE' });
    const t = await app(r.participants);
    expect(await t.run(await t.login(`env-${env}`))).toEqual({ outcome: 'WITHDRAWN' });
    expect(seen).toEqual([]);
  });

  test.each(['demo', 'staging', 'prod', 'production'])('I-T84⑦_%s에서 주소가 없으면 늘 답하지 않음이라(경고 한 줄) 탈퇴가 늘 202(DEFERRED)다', async (env) => {
    const r = withdrawalParticipantsFromEnv({ PEAKET_ENV: env });
    expect(r.participants).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    expect(await rejection(r.participants[0]!.process(ACCOUNT, { deadlineMs: 100 }))).toBeInstanceOf(WithdrawalParticipantUnavailable);
    const t = await app(r.participants);
    expect(await t.run(await t.login(`env-${env}`))).toEqual({ outcome: 'DEFERRED' });
  });

  test('I-T84⑦_주소가있으면그서버를부르는클라이언트하나이고경고가없다(운영도같다)', async () => {
    for (const env of ['local', 'prod']) {
      seen.length = 0;
      const r = withdrawalParticipantsFromEnv({ PEAKET_ENV: env, PEAKET_PURCHASE_GRPC_URL: address });
      expect(r.warnings).toEqual([]);
      expect(r.participants).toHaveLength(1);
      plan.length = 0;
      plan.push({ reply: { state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: ['WITHDRAWAL_PENDING_REASON_DEPOSIT_CANCEL_PENDING'] } });
      expect(await r.participants[0]!.process(ACCOUNT, { deadlineMs: 1_000 })).toEqual({ state: 'PENDING', reasons: ['DEPOSIT_CANCEL_PENDING'] });
      expect(seen).toHaveLength(1);
      for (const c of r.clients) c.close();
    }
  });
});
