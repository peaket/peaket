// 탈퇴 참여자와 탈퇴 미룸의 PostgreSQL 통합 시험(실제 PostgreSQL 18, 루프백 gRPC 참여자 대역, BAT-010 시험 담당).
// 정본: docs/features/identity.md §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현'·§12 I-T84, ADR-0284, docs/data.md account(closure_reason·closure_next_check_at)·
// §5 경합 행·§5.1 '탈퇴 미룸 다시 하기 고리', docs/api/proto/peaket/purchase/v1/account.proto WithdrawalParticipantService.
//
// 약속:
// - 컨테이너 하나를 파일 전체가 나눠 쓴다. 계정은 시험마다 새 소셜 ID라 서로 닿지 않는다. 고리 시험은 앞 시험이 남긴 미룬 계정을 먼 뒤로 밀어 둔다(isolate).
// - 참여자 대역은 실제 grpc-js 서버에 계약 설명자를 실은 것이고, 클라이언트는 운영 어댑터(GrpcWithdrawalParticipant)다. 대역은 받은 때의 계정 행(status·closure_reason)을 DB에서 읽어 적는다.
// - 시계는 가짜 하나다(저장소·응용 층). gRPC 데드라인은 벽시계다.
// - 값은 정본에서 적는다: 다음 확인 = 지금 + 60초, 한 바퀴 20개, 요청 경로 3초. 코드 상수를 가져오지 않는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { GrpcWithdrawalParticipant } from '../src/modules/session/adapters/grpc-withdrawal-participants.js';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { RetryPendingWithdrawals } from '../src/modules/session/application/retry-pending-withdrawals.js';
import { GetVerificationStatus } from '../src/modules/session/application/get-verification-status.js';
import { WithdrawAccount } from '../src/modules/session/application/withdraw-account.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { VerificationEraser } from '../src/modules/verification/adapters/verification-eraser.js';
import { VerificationHolds } from '../src/modules/verification/adapters/verification-holds.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { SetRestrictedCiHold } from '../src/modules/verification/application/set-restricted-ci-hold.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, ISSUER, kit, newKey, testAgency } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NEXT_CHECK_MS = 60_000;
const BATCH = 20;
const REQUEST_DEADLINE_MS = 3_000;
const DAY = 86_400_000;

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Pkg = { WithdrawalParticipantService: grpc.ServiceClientConstructor };
const pkg = (() => {
  const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], LOAD);
  return (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: Pkg } } }).peaket.purchase.v1;
})();

/** 대역의 답 하나 */
interface Step {
  delayMs?: number;
  code?: grpc.status;
  state?: 'DONE' | 'PENDING' | 'UNSPECIFIED';
  /** 답을 늦출 약속(풀리면 그때 state로 답한다) */
  hold?: Promise<void>;
}
interface Seen {
  accountId: string;
  /** 받은 때 DB의 계정 행 */
  status: string | undefined;
  reason: string | null | undefined;
  deadlineLeftMs: number;
}
/** 계정마다의 답(차례대로 꺼내고 마지막 것을 되풀이). 없으면 PENDING */
const answers = new Map<string, Step[]>();
const seen: Seen[] = [];

let pg: PostgresContainer;
let database: Database;
let server: grpc.Server;
let address: string;
const clock = fakeClock({ now: Date.parse('2026-11-18T06:17:33.509Z') });
const participants: GrpcWithdrawalParticipant[] = [];

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-withdrawal-participant-test', max: 10 });
  await ensureOutboxPartitions(database, clock, { daysAhead: 40 });
  server = new grpc.Server();
  server.addService(pkg.WithdrawalParticipantService.service, {
    ProcessAccountWithdrawal: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      void (async () => {
        const accountId = String(call.request.account_id);
        const d = call.getDeadline();
        const deadlineLeftMs = (d instanceof Date ? d.getTime() : Number(d)) - Date.now();
        const row = (await q<{ status: string; closure_reason: string | null }>('select status, closure_reason from account where id = $1', [accountId]))[0];
        seen.push({ accountId, status: row?.status, reason: row?.closure_reason, deadlineLeftMs });
        const steps = answers.get(accountId) ?? [];
        const step = (steps.length > 1 ? steps.shift() : steps[0]) ?? { state: 'PENDING' };
        if (step.hold) await step.hold;
        if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
        if (step.code !== undefined) return cb({ code: step.code, details: '가짜 오류', metadata: new grpc.Metadata(), name: 'Error', message: 'x' } as grpc.ServiceError);
        const state = step.state ?? 'PENDING';
        cb(null, state === 'PENDING' ? { state: 'WITHDRAWAL_PARTICIPANT_STATE_PENDING', reasons: ['WITHDRAWAL_PENDING_REASON_PAYMENT_PENDING_ORDER'], payment_pending_orders: 1 } : { state: `WITHDRAWAL_PARTICIPANT_STATE_${state}` });
      })();
    },
  });
  address = `127.0.0.1:${await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))))}`;
}, 180_000);

afterAll(async () => {
  for (const p of participants) p.close();
  await new Promise<void>((r) => (server ? server.tryShutdown(() => r()) : r()));
  await database?.close();
  pg?.stop();
});

beforeEach(() => {
  seen.length = 0;
  answers.clear();
});

/** failErase: 참이면 그 계정의 본인확인 기록 파기(끝내기 뒤 정리)를 실패시킨다(검증 M11, pid가 남은 채 겹치게) */
function setup(o: { failErase?: (accountId: string) => boolean } = {}) {
  const sessions = new DrizzleSessionStore(database, clock);
  const verifications = new DrizzleVerificationStore(database);
  const closure = new CloseAccount(sessions, clock);
  const claims = new VerificationClaims(verifications, closure);
  const realEraser = new VerificationEraser(verifications);
  const eraser = {
    pidsOf: (accountId: string) => realEraser.pidsOf(accountId),
    erase: async (accountId: string, now: number) => {
      if (o.failErase?.(accountId)) throw new Error('주입한 장애(본인확인 기록 파기)');
      return realEraser.erase(accountId, now);
    },
  };
  const participant = new GrpcWithdrawalParticipant({ address });
  participants.push(participant);
  const build = async () => {
    const k = await kit(sessions, { claims, clock, reverifications: claims });
    const withdraw = new WithdrawAccount(sessions, new JoseReauthVerifier(k.keys, ISSUER, clock), eraser, clock, new VerificationHolds(verifications), undefined, undefined, [participant]);
    return { k, withdraw };
  };
  /** 같은 DB를 보는 다른 파드의 고리 */
  const pod = () => new RetryPendingWithdrawals(new DrizzleSessionStore(database, clock), eraser, clock, [participant]);
  return { sessions, verifications, closure, claims, eraser, build, pod, hold: new SetRestrictedCiHold(verifications, clock) };
}

async function world(o: { failErase?: (accountId: string) => boolean } = {}) {
  const s = setup(o);
  const { k, withdraw } = await s.build();
  const provider = testAgency(clock);
  const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const login = (id: string) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: id, email: `${id}@kakao.test`, deviceId: 'dev-1' });
  const verify = async (accountId: string, person: string, birth = '2000-01-01') => {
    const st = await new StartVerification(s.verifications, provider, s.closure, clock).run({ accountId, sessionId: null, purpose: 'FIRST', next: '/' });
    return new ConfirmVerification(s.verifications, provider, hashers, s.closure, clock)
      .run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person, birth }) })
      .catch((e: unknown) => e);
  };
  const reauth = async (x: { accountId: string; sessionId: string }) => (await k.signer.reauth({ accountId: x.accountId, sessionId: x.sessionId, provider: 'kakao', strength: 'verified', operation: 'ACCOUNT_WITHDRAW' }, clock.now())).token;
  const run = async (x: { accountId: string; sessionId: string }, token?: string, body: { acknowledgeFraudHold?: boolean } = {}) =>
    withdraw.run({ accountId: x.accountId, sessionId: x.sessionId, reauthToken: token ?? (await reauth(x)), body }).catch((e: unknown) => (e instanceof AccountError ? e.code : Promise.reject(e)));
  /** 로그인·본인확인한 계정을 요청 경로로 미룬다 */
  const deferred = async (id: string) => {
    const x = await login(id);
    await verify(x.accountId, `${id}-person`);
    answers.set(x.accountId, [{ state: 'PENDING' }]);
    expect(await run(x)).toEqual({ outcome: 'DEFERRED' });
    answers.delete(x.accountId);
    return x;
  };
  return { ...s, k, withdraw, login, verify, reauth, run, deferred, retry: s.pod() };
}

type AccountRow = { status: string; closure_reason: string | null; closure_started_at: Date | null; closure_next_check_at: Date | null; deleted_at: Date | null };
const accountOf = async (id: string): Promise<AccountRow> => (await q<AccountRow>('select status, closure_reason, closure_started_at, closure_next_check_at, deleted_at from account where id = $1', [id]))[0]!;
const liveSessions = async (id: string) => (await q('select 1 from session where account_id = $1 and terminated_at is null', [id])).length;
const terminations = async (id: string) =>
  (await q<{ payload: Buffer }>("select payload from outbox where topic = 'control.sessions-terminated' and msg_key = $1", [id])).map((e) => (JSON.parse(e.payload.toString()) as { reason: string }).reason);
const withdrawnEvents = async (id: string) => (await q("select 1 from outbox where topic = 'identity.accounts-withdrawn' and msg_key = $1", [id])).length;
const verificationRows = async (id: string) => (await q('select 1 from identity_verification where account_id = $1', [id])).length;
/** 앞 시험이 남긴 미룬 계정을 고리가 잡지 않게 먼 뒤로 민다 */
const isolate = () => q("update account set closure_next_check_at = '2100-01-01T00:00:00Z' where status = 'WITHDRAWAL_PENDING' and closure_reason = 'WITHDRAWAL'");

describe('마이그레이션(docs/data.md account, I-T84)', () => {
  test('I-T84_정리사유CHECK는UNDER_14·WITHDRAWAL만받고_closure_next_check_at칸과미룬계정만담는부분인덱스account_withdrawal_retry_idx가있다', async () => {
    const t = await world();
    const a = await t.login('m-1');
    await expect(q("update account set status = 'WITHDRAWAL_PENDING', closure_reason = 'WITHDRAWAL' where id = $1", [a.accountId])).resolves.toBeDefined();
    await expect(q("update account set closure_reason = 'OTHER' where id = $1", [a.accountId])).rejects.toThrow(/account_closure_reason_check/);
    await q("update account set status = 'ACTIVE', closure_reason = null where id = $1", [a.accountId]);
    const col = await q<{ data_type: string }>("select data_type from information_schema.columns where table_name = 'account' and column_name = 'closure_next_check_at'");
    expect(col).toEqual([{ data_type: 'timestamp with time zone' }]);
    const idx = await q<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'account' and indexname = 'account_withdrawal_retry_idx'");
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toMatch(/\(closure_next_check_at\)/);
    expect(idx[0]!.indexdef).toMatch(/WHERE .*status.*'WITHDRAWAL_PENDING'.*closure_reason.*'WITHDRAWAL'/);
  });
});

describe('탈퇴 요청(I-T84 ①②③⑤⑦)', () => {
  test('I-T84①_PostgreSQL에서참여자가DONE이면_WITHDRAWN이고계정DELETED·세션둘이DELETE사건과함께끝나며_탈퇴사건한건이고대역이받은계정ID는그계정이다 [ASVS v5.0.0-7.4.2]', async () => {
    const t = await world();
    const a = await t.login('i1-1');
    await t.login('i1-1');
    await t.verify(a.accountId, 'i1-person');
    answers.set(a.accountId, [{ state: 'DONE' }]);
    expect(await t.run(a)).toEqual({ outcome: 'WITHDRAWN' });
    expect(await accountOf(a.accountId)).toMatchObject({ status: 'DELETED', deleted_at: new Date(clock.now()) });
    expect(await liveSessions(a.accountId)).toBe(0);
    expect(await terminations(a.accountId)).toEqual(['DELETE', 'DELETE']);
    expect(await withdrawnEvents(a.accountId)).toBe(1);
    expect(await verificationRows(a.accountId)).toBe(0);
    expect(seen.map((x) => x.accountId)).toEqual([a.accountId]);
    expect(seen[0]!.deadlineLeftMs).toBeLessThanOrEqual(REQUEST_DEADLINE_MS);
  });

  test('I-T84②_PostgreSQL에서참여자가PENDING이면_DEFERRED이고_status·closure_reason·closure_started_at=요청시각·closure_next_check_at=요청시각+60초_세션·로그인수단·기기·본인확인기록그대로·탈퇴사건없음_대역이받은때이미미룸이커밋됐고_쓴토큰은403', async () => {
    const t = await world();
    clock.advance(7_123);
    const a = await t.login('i2-1');
    await t.login('i2-1');
    await t.verify(a.accountId, 'i2-person');
    const token = await t.reauth(a);
    const at = clock.now();
    expect(await t.run(a, token)).toEqual({ outcome: 'DEFERRED' });
    expect(await accountOf(a.accountId)).toEqual({ status: 'WITHDRAWAL_PENDING', closure_reason: 'WITHDRAWAL', closure_started_at: new Date(at), closure_next_check_at: new Date(at + NEXT_CHECK_MS), deleted_at: null });
    expect(await liveSessions(a.accountId)).toBe(2);
    expect(await q('select 1 from account_provider where account_id = $1', [a.accountId])).toHaveLength(1);
    expect(await q('select 1 from device where account_id = $1', [a.accountId])).toHaveLength(1);
    expect(await q<{ email: string }>('select email from account where id = $1', [a.accountId])).toEqual([{ email: 'i2-1@kakao.test' }]);
    expect(await verificationRows(a.accountId)).toBe(1);
    expect(await withdrawnEvents(a.accountId)).toBe(0);
    expect(await terminations(a.accountId)).toEqual([]);
    expect(seen).toEqual([{ accountId: a.accountId, status: 'WITHDRAWAL_PENDING', reason: 'WITHDRAWAL', deadlineLeftMs: expect.any(Number) }]);
    expect(await t.run(a, token)).toBe('REAUTH_REQUIRED');
    expect(seen).toHaveLength(1);
  });

  test('I-T84③_PostgreSQL에서참여자호출이UNAVAILABLE이거나요청경로3초안에답하지않거나답이UNSPECIFIED면_②와같은DEFERRED·미룸행이다', async () => {
    const t = await world();
    const steps: Array<[string, Step]> = [
      ['unavailable', { code: grpc.status.UNAVAILABLE }],
      ['late', { delayMs: REQUEST_DEADLINE_MS + 700, state: 'DONE' }],
      ['unspecified', { state: 'UNSPECIFIED' }],
    ];
    for (const [name, step] of steps) {
      const a = await t.login(`i3-${name}`);
      answers.set(a.accountId, [step]);
      const at = clock.now();
      expect({ name, r: await t.run(a) }).toEqual({ name, r: { outcome: 'DEFERRED' } });
      expect({ name, row: await accountOf(a.accountId) }).toEqual({ name, row: { status: 'WITHDRAWAL_PENDING', closure_reason: 'WITHDRAWAL', closure_started_at: new Date(at), closure_next_check_at: new Date(at + NEXT_CHECK_MS), deleted_at: null } });
      expect(await liveSessions(a.accountId)).toBe(1);
    }
  }, 30_000);

  test('I-T84⑤_PostgreSQL에서미룬계정이새재인증토큰으로다시요청하면_참여자를다시부르고PENDING이면시작시각그대로·다음확인=다시요청+60초_DONE이면WITHDRAWN_미룬동안로그인되고토큰에ticket:buy·pid가없다', async () => {
    const t = await world();
    const a = await t.login('i5-1');
    await t.verify(a.accountId, 'i5-person');
    const started = clock.now();
    answers.set(a.accountId, [{ state: 'PENDING' }]);
    expect(await t.run(a)).toEqual({ outcome: 'DEFERRED' });
    // 미룬 동안 로그인은 되고 새 토큰에 ticket:buy·pid가 없다
    const again = await t.login('i5-1');
    expect(again.accountId).toBe(a.accountId);
    const claims = JSON.parse(Buffer.from(again.accessToken.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims.scope).toBeUndefined();
    expect(claims.pid).toBeUndefined();
    clock.advance(41_007);
    const second = clock.now();
    expect(await t.run(a)).toEqual({ outcome: 'DEFERRED' });
    expect(await accountOf(a.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closure_started_at: new Date(started), closure_next_check_at: new Date(second + NEXT_CHECK_MS) });
    answers.set(a.accountId, [{ state: 'DONE' }]);
    clock.advance(2_000);
    expect(await t.run(again)).toEqual({ outcome: 'WITHDRAWN' });
    expect(seen.map((x) => x.accountId)).toEqual([a.accountId, a.accountId, a.accountId]);
    expect(await accountOf(a.accountId)).toMatchObject({ status: 'DELETED' });
    expect(await liveSessions(a.accountId)).toBe(0);
    expect(await withdrawnEvents(a.accountId)).toBe(1);
  });

  test('I-T84⑦_PostgreSQL에서대조값보관행이있으면409이고_계정은ACTIVE그대로이며참여자는불리지않는다', async () => {
    const t = await world();
    const a = await t.login('i7-hold');
    await t.verify(a.accountId, 'i7-hold-person');
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: '0190f3a1-7c2e-7a00-8000-0000000084c7', state: 'RESTRICTED', until: clock.now() + 90 * DAY, version: 1 })).toBe('OK');
    expect(await t.run(a)).toBe('CONFIRMATION_REQUIRED');
    expect(seen).toEqual([]);
    expect(await accountOf(a.accountId)).toMatchObject({ status: 'ACTIVE', closure_reason: null, closure_next_check_at: null });
  });
});

describe('다시 하기 고리(I-T84 ④⑦)', () => {
  test('I-T84④_PostgreSQL에서다음확인−1ms에는잡지않고그시각에잡으며잡으면다음확인=잡은시각+60초_PENDING이면그대로_DONE이면끝낸다', async () => {
    const t = await world();
    await isolate();
    const a = await t.deferred('r4-1');
    const b = await t.deferred('r4-2');
    seen.length = 0;
    clock.advance(NEXT_CHECK_MS - 1);
    expect(await t.retry.run()).toEqual({ claimed: 0, withdrawn: 0, deferred: 0, failed: 0 });
    expect(seen).toEqual([]);
    clock.advance(1);
    const claimedAt = clock.now();
    answers.set(a.accountId, [{ state: 'PENDING' }]);
    answers.set(b.accountId, [{ state: 'DONE' }]);
    expect(await t.retry.run()).toEqual({ claimed: 2, withdrawn: 1, deferred: 1, failed: 0 });
    expect(await accountOf(a.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closure_reason: 'WITHDRAWAL', closure_next_check_at: new Date(claimedAt + NEXT_CHECK_MS) });
    expect(await liveSessions(a.accountId)).toBe(1);
    expect(await accountOf(b.accountId)).toMatchObject({ status: 'DELETED', deleted_at: new Date(claimedAt) });
    expect(await terminations(b.accountId)).toEqual(['DELETE']);
    expect(await withdrawnEvents(b.accountId)).toBe(1);
    // 고리는 잡은 행을 잠근 채 부르지 않는다: 대역이 받은 때 행은 아직 미룸이다
    expect(seen.map((x) => [x.accountId, x.status])).toEqual(expect.arrayContaining([[a.accountId, 'WITHDRAWAL_PENDING'], [b.accountId, 'WITHDRAWAL_PENDING']]));
  });

  test('I-T84④_PostgreSQL에서정리사유UNDER_14와ACTIVE·DELETED계정은잡지않고_21개면20개를다음확인순으로잡는다', async () => {
    const t = await world();
    await isolate();
    const kid = await t.login('r4b-kid');
    expect(await t.verify(kid.accountId, 'r4b-kid', '2014-02-02')).toMatchObject({ code: 'UNDER_14' });
    const gone = await t.login('r4b-gone');
    answers.set(gone.accountId, [{ state: 'DONE' }]);
    expect(await t.run(gone)).toEqual({ outcome: 'WITHDRAWN' });
    await t.login('r4b-active');
    const ids: string[] = [];
    for (let i = 0; i < BATCH + 1; i++) {
      ids.push((await t.deferred(`r4b-${i}`)).accountId);
      clock.advance(11);
    }
    seen.length = 0;
    clock.advance(30 * DAY);
    expect(await t.retry.run()).toMatchObject({ claimed: BATCH, deferred: BATCH });
    expect(seen.map((x) => x.accountId).sort()).toEqual(ids.slice(0, BATCH).sort());
    expect(seen.map((x) => x.accountId)).not.toContain(kid.accountId);
    seen.length = 0;
    expect(await t.retry.run()).toMatchObject({ claimed: 1 });
    expect(seen.map((x) => x.accountId)).toEqual([ids[BATCH]]);
    expect(await accountOf(kid.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closure_reason: 'UNDER_14', closure_next_check_at: null });
  });

  test('I-T84④_PostgreSQL에서두파드가같은때돌아도한계정은한번만잡히고_한계정의참여자실패가다른계정의끝내기를막지않는다', async () => {
    const t = await world();
    await isolate();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push((await t.deferred(`r4c-${i}`)).accountId);
      clock.advance(7);
    }
    // 첫 계정은 실패, 나머지는 늦게(250ms) DONE이라 두 파드의 바퀴가 겹친다
    answers.set(ids[0]!, [{ code: grpc.status.INTERNAL }]);
    for (const id of ids.slice(1)) answers.set(id, [{ delayMs: 250, state: 'DONE' }]);
    seen.length = 0;
    clock.advance(NEXT_CHECK_MS);
    const [p1, p2] = await Promise.all([t.pod().run(), t.pod().run()]);
    expect(p1.claimed + p2.claimed).toBe(6);
    expect(p1.withdrawn + p2.withdrawn).toBe(5);
    expect(p1.failed + p2.failed).toBe(1);
    const perAccount = new Map<string, number>();
    for (const x of seen) perAccount.set(x.accountId, (perAccount.get(x.accountId) ?? 0) + 1);
    expect([...perAccount.entries()].sort()).toEqual(ids.map((id) => [id, 1]).sort());
    for (const id of ids.slice(1)) {
      expect(await accountOf(id)).toMatchObject({ status: 'DELETED' });
      expect(await withdrawnEvents(id)).toBe(1);
      expect(await terminations(id)).toEqual(['DELETE']);
    }
    expect(await accountOf(ids[0]!)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closure_next_check_at: new Date(clock.now() + NEXT_CHECK_MS) });
  });

  test('I-T84④_장애주입_PostgreSQL에서잡기를커밋한뒤그파드가참여자를부르지못하고죽어도_다음확인시각뒤다른파드가잡아끝낸다', async () => {
    const t = await world();
    await isolate();
    const a = await t.deferred('r4d-1');
    clock.advance(NEXT_CHECK_MS);
    const claimed = await t.sessions.transaction((tx) => tx.claimPendingWithdrawals(clock.now(), clock.now() + NEXT_CHECK_MS, BATCH));
    expect(claimed).toEqual([a.accountId]);
    seen.length = 0;
    answers.set(a.accountId, [{ state: 'DONE' }]);
    expect(await t.retry.run()).toMatchObject({ claimed: 0 });
    clock.advance(NEXT_CHECK_MS - 1);
    expect(await t.retry.run()).toMatchObject({ claimed: 0 });
    expect(seen).toEqual([]);
    clock.advance(1);
    expect(await t.retry.run()).toEqual({ claimed: 1, withdrawn: 1, deferred: 0, failed: 0 });
    expect(await accountOf(a.accountId)).toMatchObject({ status: 'DELETED' });
  });

  test('I-T84⑦_PostgreSQL에서요청경로의끝내기와고리의끝내기가겹쳐도_계정은한번끝나고탈퇴사건은한건·세션종료사건은세션마다한번이다', async () => {
    const t = await world();
    await isolate();
    const a = await t.login('r7-1');
    await t.login('r7-1');
    await t.verify(a.accountId, 'r7-person');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    // 첫 호출(요청 경로)은 풀릴 때까지 답을 늦추고 DONE, 다음 호출(고리)은 바로 DONE
    answers.set(a.accountId, [{ hold, state: 'DONE' }, { state: 'DONE' }]);
    // 요청 경로의 3초 안에 고리가 끝내고 요청 경로도 DONE을 받게 한다
    const request = t.run(a);
    for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    clock.advance(NEXT_CHECK_MS);
    expect(await t.retry.run()).toMatchObject({ claimed: 1, withdrawn: 1 });
    release();
    const r = await request;
    expect(r).not.toBeInstanceOf(Error);
    expect(seen).toHaveLength(2);
    expect(await accountOf(a.accountId)).toMatchObject({ status: 'DELETED' });
    expect(await withdrawnEvents(a.accountId)).toBe(1);
    expect(await terminations(a.accountId)).toEqual(['DELETE', 'DELETE']);
  });
});

// 검증이 놓친 M11·M10a-pg(BAT-010 검증 2a6066f0, 계획 9의 M10·M11)
describe('겹친 끝내기의 상태 다시 보기(I-T84 ⑦, 검증 M11)', () => {
  test('I-T84⑦_장애주입_PostgreSQL에서고리가먼저끝냈지만본인확인기록파기가실패해pid가남은채요청경로가끝내기에닿아도_탈퇴사건은한건·세션마다DELETE한번이다', async () => {
    let erased = 0;
    const t = await world({
      failErase: () => {
        erased++;
        return true;
      },
    });
    await isolate();
    const a = await t.login('m11-1');
    await t.login('m11-1');
    await t.verify(a.accountId, 'm11-person');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    // 요청 경로는 풀릴 때까지 늦게 DONE, 고리는 바로 DONE
    answers.set(a.accountId, [{ hold, state: 'DONE' }, { state: 'DONE' }]);
    const request = t.run(a);
    for (let i = 0; i < 200 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    clock.advance(NEXT_CHECK_MS);
    expect(await t.retry.run()).toMatchObject({ claimed: 1, withdrawn: 1 });
    // 끊긴 사례가 실제로 있었다: 고리의 끝내기 뒤 파기가 실패해 본인확인 기록(pid)이 남았다
    expect(erased).toBe(1);
    expect(await verificationRows(a.accountId)).toBe(1);
    release();
    const r = await request;
    expect(r).not.toBeInstanceOf(Error);
    expect(seen).toHaveLength(2);
    expect(await accountOf(a.accountId)).toMatchObject({ status: 'DELETED' });
    expect(await withdrawnEvents(a.accountId)).toBe(1);
    expect(await terminations(a.accountId)).toEqual(['DELETE', 'DELETE']);
  });

  test('I-T84⑦_PostgreSQL에서요청경로와고리의참여자답을같은때풀어두끝내기가모두pid를읽은뒤잠금을다퉈도_탈퇴사건은한건·세션마다DELETE한번이다', async () => {
    const t = await world();
    await isolate();
    const a = await t.login('m11-2');
    await t.login('m11-2');
    await t.verify(a.accountId, 'm11-2-person');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    answers.set(a.accountId, [{ hold, state: 'DONE' }, { hold, state: 'DONE' }]);
    const request = t.run(a);
    for (let i = 0; i < 200 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    clock.advance(NEXT_CHECK_MS);
    const round = t.retry.run();
    for (let i = 0; i < 200 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(2);
    release();
    const [r, report] = await Promise.all([request, round]);
    expect(r).not.toBeInstanceOf(Error);
    expect(report).toMatchObject({ claimed: 1, failed: 0 });
    expect(await accountOf(a.accountId)).toMatchObject({ status: 'DELETED' });
    expect(await withdrawnEvents(a.accountId)).toBe(1);
    expect(await terminations(a.accountId)).toEqual(['DELETE', 'DELETE']);
  });
});

describe('PostgreSQL 저장소의 탈퇴 미룸 판정(I-T84 ⑥, 검증 M10a-pg)', () => {
  test('I-T84⑥_PostgreSQL에서GetVerificationStatus는요청경로가미룬계정의살아있는세션에verified거짓·withdrawalPending참이고_끝난세션·만14세미만정리계정·ACTIVE계정은거짓이다', async () => {
    const t = await world();
    const status = new GetVerificationStatus(t.sessions, t.claims, clock);
    const a = await t.login('m10-1');
    const gone = await t.login('m10-1');
    await t.verify(a.accountId, 'm10-person');
    // 미루기 전(ACTIVE·본인확인함)
    expect(await status.run({ accountId: a.accountId, sessionId: a.sessionId })).toMatchObject({ verified: true, withdrawalPending: false });
    answers.set(a.accountId, [{ state: 'PENDING' }]);
    expect(await t.run(a)).toEqual({ outcome: 'DEFERRED' });
    expect(await status.run({ accountId: a.accountId, sessionId: a.sessionId })).toEqual({ verified: false, pid: '', previousPid: '', withdrawalPending: true });
    expect(await t.sessions.transaction((tx) => tx.withdrawalPendingOf(a.accountId))).toBe(true);
    // 끝난 세션은 거짓
    await t.k.end.run({ sessionId: gone.sessionId, accountId: gone.accountId });
    expect(await status.run({ accountId: a.accountId, sessionId: gone.sessionId })).toEqual({ verified: false, pid: '', previousPid: '', withdrawalPending: false });
    // 만 14세 미만으로 정리 중(UNDER_14)인 계정은 저장소 판정도 GetVerificationStatus도 거짓
    const kid = await t.login('m10-kid');
    expect(await t.verify(kid.accountId, 'm10-kid', '2014-04-04')).toMatchObject({ code: 'UNDER_14' });
    expect(await accountOf(kid.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closure_reason: 'UNDER_14' });
    expect(await t.sessions.transaction((tx) => tx.withdrawalPendingOf(kid.accountId))).toBe(false);
    expect(await status.run({ accountId: kid.accountId, sessionId: kid.sessionId })).toEqual({ verified: false, pid: '', previousPid: '', withdrawalPending: false });
    // ACTIVE이고 본인확인 전인 계정도 거짓
    const plain = await t.login('m10-plain');
    expect(await t.sessions.transaction((tx) => tx.withdrawalPendingOf(plain.accountId))).toBe(false);
    expect(await status.run({ accountId: plain.accountId, sessionId: plain.sessionId })).toEqual({ verified: false, pid: '', previousPid: '', withdrawalPending: false });
  });
});
