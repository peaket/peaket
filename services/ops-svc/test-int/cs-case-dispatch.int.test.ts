// 보낼 호출 표(ops 0031 cs_case_dispatch)의 실제 PostgreSQL 동작(F-06-7 GAT-280, B-T28 ②⑥, B-T10 ⑥). 시험 담당 lane3-f067-test.
// 실제 PostgreSQL 18 + AppModule.register({ database, csAppeals }) + 실제 gRPC 클라이언트 → 받는 쪽 gRPC 서버 대역(test/cs-appeal-support.ts)의 상태 주입.
// 받는 쪽을 대역으로 둔 까닭: 8번 실패·잡음 겹치기처럼 받는 쪽 답을 정해야 하는 시험이다. 실제 queue·trust·identity 서버 끝에서 끝은 verification-appeal.int.test.ts다.
// 보는 것: 결정 한 트랜잭션(건 해결·verification_case·보낼 호출·감사·멱등 기록)과 그 되돌림, 8번 [가정] 뒤 FAILED·ops_alert SEV3과 반영 뒤 풀림,
// 두 ops-svc 인스턴스의 배경 작업이 겹쳐도 한 번(FOR UPDATE SKIP LOCKED + claimed_until), 같은 판 동시 결정은 한 벌, 멱등 다시 보내기.
// 정본: docs/data.md cs_case_dispatch·verification_case·§5.1 'CS 처리함 보낼 호출' 행, docs/features/bot-defense.md §12 'CS 처리 첫 구현'의 '결정'·'다시 보내기'.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import * as casesModule from '../src/modules/cases/index.js';
import { NOTE, RETRY, appealEnv, appealFixture, loadWiring, startAppealStubs, waitAfterFailure, type AppealStubs } from '../test/cs-appeal-support.js';
import { caseRequest, testCalendar } from '../test/cs-support.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const identity = new FakeIdentity();
const clock = fakeClock({ now: Date.parse('2026-11-23T01:00:00.000Z') });
let container: PostgresContainer | undefined;
let admin: pg.Client;
let db: Database;
let stubs: AppealStubs;
type Svc = Awaited<ReturnType<typeof createService>>;
let svc1: Svc;
let svc2: Svc;
const closers: Array<() => void> = [];

async function opsService(name: string): Promise<Svc> {
  const wiring = await loadWiring();
  const made = wiring?.csAppealPortsFromEnv(appealEnv(stubs, { env: 'ci' }));
  if (made) closers.push(() => made.close());
  return createService({
    name: 'ops-svc',
    module: AppModule.register({
      database: db,
      calendar: testCalendar(),
      background: false,
      ...(made ? { csAppeals: { ...(made.appeals ? { appeals: made.appeals } : {}), ...(made.labels ? { labels: made.labels } : {}), ...(made.evidence ? { evidence: made.evidence } : {}), ...(made.holds ? { holds: made.holds } : {}) } } : {}),
    }),
    env: { PEAKET_ENV: 'ci', OTEL_SERVICE_NAME: name },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-f067-dispatch-it', max: 12 });
  stubs = await startAppealStubs();
  svc1 = await opsService('ops-svc-1');
  svc2 = await opsService('ops-svc-2');
}, 180_000);

afterAll(async () => {
  await svc1?.close();
  await svc2?.close();
  for (const c of closers) c();
  await stubs?.close();
  await db?.close();
  await admin?.end().catch(() => undefined);
  container?.stop();
});

const q = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => admin.query<T>(text, params).then((r) => r.rows);
const parse = (payload: string): Record<string, unknown> => (payload ? (JSON.parse(payload) as Record<string, unknown>) : {});
const typeOf = (b: Record<string, unknown>): string => String(b.type ?? '').split('/').pop() ?? '';

async function run(s: Svc = svc1): Promise<void> {
  const Job = casesModule.CsCaseDispatchJob;
  if (!Job) throw new Error('CsCaseDispatchJob이 없다(계획 §4)');
  await s.app.get(Job).runOnce();
}
async function open(fx = appealFixture()) {
  stubs.appeals.set(fx.appealId, fx);
  const r = await svc1.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(caseRequest('VERIFICATION_APPEAL', { sourceId: fx.appealId, category: fx.reasonCategory })) });
  expect(r.statusCode, r.payload).toBe(202);
  return { caseId: String(parse(r.payload).caseId), fx };
}
async function decide(who: Record<string, string>, caseId: string, body: unknown, o: { ifMatch?: string; key?: string; svc?: Svc } = {}) {
  const r = await (o.svc ?? svc1).http.inject({
    method: 'POST',
    url: `/v1/ops/cases/${caseId}/verification-appeal-decision`,
    headers: { ...who, 'content-type': 'application/json', 'if-match': o.ifMatch ?? '"1"', 'idempotency-key': o.key ?? randomUUID() },
    payload: JSON.stringify(body),
  });
  return { status: r.statusCode, body: parse(r.payload) };
}
const dispatchRows = (caseId: string) =>
  q<{ call: string; state: string; attempts: number; source_version: string; last_error: string | null; next_attempt_at: Date | null; failed_alerted_at: Date | null; result: string | null }>(
    'select call, state, attempts, source_version::text as source_version, last_error, next_attempt_at, failed_alerted_at, result from cs_case_dispatch where case_id = $1 order by call',
    [caseId],
  );
const rowOf = async (caseId: string, call: string) => (await dispatchRows(caseId)).find((r) => r.call === call);

describe('B-T28 ② 결정 한 트랜잭션', () => {
  test('B-T28 ② 결정 뒤 같은 트랜잭션의 건 해결·verification_case 결과·보낼 호출 셋(새 판)·감사 한 줄이 있고 pid·메모·이의 글은 감사에 없다', async () => {
    const { caseId, fx } = await open();
    await run();
    stubs.queue.fail(grpc.status.UNAVAILABLE, 'ResolveVerificationAppeal');
    try {
      const agent = identity.ops('cs_agent');
      const r = await decide(agent, caseId, { outcome: 'ACCEPTED', resultNote: NOTE });
      expect(r.status).toBe(202);
      expect(await q('select status, version::text as version, result_note, resolved_at is not null as resolved from cs_case where id = $1', [caseId])).toEqual([{ status: 'RESOLVED', version: '2', result_note: NOTE, resolved: true }]);
      expect(await q('select status, appeal_result, decided_by::text as decided_by, decided_at is not null as decided, pid, appeal_text from verification_case where case_id = $1', [caseId])).toEqual([
        { status: 'RUNNING', appeal_result: 'ACCEPTED', decided_by: agent['x-user-id'], decided: true, pid: fx.pid, appeal_text: fx.text },
      ]);
      expect((await dispatchRows(caseId)).map((d) => [d.call, d.source_version])).toEqual([
        ['ACCOUNT_HOLD_CLOSE', '2'],
        ['ACCOUNT_HOLD_OPEN', '1'],
        ['APPEAL_COPY', '1'],
        ['QUEUE_RESOLVE', '2'],
        ['TRUST_LABEL', '2'],
      ]);
      const audit = await q<{ record_json: unknown }>("select record_json from audit_chain where record_type = 'CS_CASE_UPDATED' and record_id = $1", [caseId]);
      expect(audit).toHaveLength(1);
      const raw = JSON.stringify(audit);
      expect(raw).toContain('ACCEPTED');
      for (const secret of [fx.pid, NOTE, fx.text, fx.accountId]) expect(raw).not.toContain(secret);
    } finally {
      stubs.queue.restore();
    }
  });

  test('B-T28 ② 보낼 호출을 쓰다 트랜잭션이 깨지면 건 해결·결정·감사가 모두 되돌려지고 받는 쪽을 부르지 않는다', async () => {
    const { caseId } = await open();
    await run();
    const resolvesBefore = stubs.queue.count('ResolveVerificationAppeal');
    const key = randomUUID();
    // 시험 리뷰 2 TR-20 반영: 함정 요청과 같은 키 다시 보내기는 같은 계정이어야 멱등 범위가 같다
    const agent = identity.ops('cs_agent');
    // 시험만의 함정: 이 건의 QUEUE_RESOLVE 행을 넣으면 트랜잭션이 깨진다
    await admin.query(`create or replace function f067_break() returns trigger language plpgsql as $$ begin if new.case_id = '${caseId}'::uuid and new.call = 'QUEUE_RESOLVE' then raise exception 'f067 trap'; end if; return new; end $$`);
    await admin.query('create trigger f067_break before insert on cs_case_dispatch for each row execute function f067_break()');
    try {
      const r = await decide(agent, caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { key });
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(await q('select status, version::text as version, result_note from cs_case where id = $1', [caseId])).toEqual([{ status: 'OPEN', version: '1', result_note: null }]);
      expect(await q('select status, appeal_result, decided_by from verification_case where case_id = $1', [caseId])).toEqual([{ status: 'PENDING', appeal_result: null, decided_by: null }]);
      expect((await dispatchRows(caseId)).map((d) => d.call)).toEqual(['ACCOUNT_HOLD_OPEN', 'APPEAL_COPY']);
      expect(await q("select 1 from audit_chain where record_type = 'CS_CASE_UPDATED' and record_id = $1", [caseId])).toEqual([]);
      expect(stubs.queue.count('ResolveVerificationAppeal')).toBe(resolvesBefore);
    } finally {
      await admin.query('drop trigger f067_break on cs_case_dispatch');
      await admin.query('drop function f067_break()');
    }
    // 시험 리뷰 1 TR-04 반영: 함정을 치우면 **같은 키**로 다시 보내도 새 결정이 된다(멱등 기록도 함께 되돌려져 저장된 5xx·처리 중이 아니다)
    const again = await decide(agent, caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { key });
    expect([again.status, again.body.status, again.body.version]).toEqual([202, 'RESOLVED', 2]);
  });

  // 시험 리뷰 1 TR-04 반영: 커밋 때 터지는 함정(지연 제약 트리거). '커밋 전에 보내는' 틀린 구현을 받는 쪽 호출 수로 잡는다(bot-defense §12 '결정': 커밋 뒤 보내 봄)
  test('B-T28 ② 커밋 때 트랜잭션이 깨지면 받는 쪽 호출이 0번이고 건·결정·감사가 되돌려지며, 같은 키로 다시 보내면 새 결정이 된다', async () => {
    const { caseId } = await open();
    await run();
    const before = [stubs.queue.count('ResolveVerificationAppeal'), stubs.trust.count('ApplyLabel'), stubs.identity.count('SetAccountHold')];
    const key = randomUUID();
    // 시험 리뷰 2 TR-20 반영: 함정 요청과 같은 키 다시 보내기는 같은 계정이어야 멱등 범위가 같다
    const agent = identity.ops('cs_agent');
    await admin.query(`create or replace function f067_commit_break() returns trigger language plpgsql as $$ begin if new.case_id = '${caseId}'::uuid then raise exception 'f067 commit trap'; end if; return new; end $$`);
    await admin.query('create constraint trigger f067_commit_break after insert on cs_case_dispatch deferrable initially deferred for each row execute function f067_commit_break()');
    try {
      const r = await decide(agent, caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { key });
      expect(r.status).toBeGreaterThanOrEqual(500);
      // 보내 보기가 커밋 뒤라면 받는 쪽은 아무것도 받지 않았다
      expect([stubs.queue.count('ResolveVerificationAppeal'), stubs.trust.count('ApplyLabel'), stubs.identity.count('SetAccountHold')]).toEqual(before);
      expect(await q('select status, version::text as version from cs_case where id = $1', [caseId])).toEqual([{ status: 'OPEN', version: '1' }]);
      expect(await q('select appeal_result from verification_case where case_id = $1', [caseId])).toEqual([{ appeal_result: null }]);
      expect(await q("select 1 from audit_chain where record_type = 'CS_CASE_UPDATED' and record_id = $1", [caseId])).toEqual([]);
    } finally {
      await admin.query('drop trigger f067_commit_break on cs_case_dispatch');
      await admin.query('drop function f067_commit_break()');
    }
    const again = await decide(agent, caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { key });
    expect([again.status, again.body.status, again.body.version]).toEqual([202, 'RESOLVED', 2]);
  });

  test('B-T28 ② 같은 판으로 두 인스턴스에서 동시에 결정하면 하나 202·하나 412이고 결과는 이긴 쪽 하나다', async () => {
    const { caseId } = await open();
    await run();
    const [a, b] = await Promise.all([
      decide(identity.ops('cs_agent'), caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { svc: svc1 }),
      decide(identity.ops('cs_lead'), caseId, { outcome: 'REJECTED', resultNote: NOTE }, { svc: svc2 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 412]);
    const won = a.status === 202 ? 'ACCEPTED' : 'REJECTED';
    expect((await q<{ appeal_result: string }>('select appeal_result from verification_case where case_id = $1', [caseId]))[0]!.appeal_result).toBe(won);
    expect((await q<{ n: string }>("select count(*)::text as n from audit_chain where record_type = 'CS_CASE_UPDATED' and record_id = $1", [caseId]))[0]!.n).toBe('1');
    expect((await dispatchRows(caseId)).map((d) => d.call)).toEqual(won === 'ACCEPTED' ? ['ACCOUNT_HOLD_CLOSE', 'ACCOUNT_HOLD_OPEN', 'APPEAL_COPY', 'QUEUE_RESOLVE', 'TRUST_LABEL'] : ['ACCOUNT_HOLD_CLOSE', 'ACCOUNT_HOLD_OPEN', 'APPEAL_COPY', 'QUEUE_RESOLVE']);
  });

  test('B-T28 ② 같은 Idempotency-Key·같은 본문을 다른 인스턴스로 다시 보내도 같은 202이고, 다른 본문은 422 idempotency-key-reused다', async () => {
    const { caseId } = await open();
    await run();
    const agent = identity.ops('cs_agent');
    const key = randomUUID();
    const body = { outcome: 'REJECTED', resultNote: NOTE };
    const first = await decide(agent, caseId, body, { key, svc: svc1 });
    const replay = await decide(agent, caseId, body, { key, svc: svc2 });
    expect([first.status, replay.status, replay.body]).toEqual([202, 202, first.body]);
    const reused = await decide(agent, caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { key, svc: svc2 });
    expect([reused.status, typeOf(reused.body)]).toEqual([422, 'idempotency-key-reused']);
    expect((await q<{ n: string }>("select count(*)::text as n from audit_chain where record_type = 'CS_CASE_UPDATED' and record_id = $1", [caseId]))[0]!.n).toBe('1');
  });
});

describe('B-T28 ⑥ B-T10 ⑥ 다시 보내기와 반영 실패(실제 PostgreSQL)', () => {
  test('B-T28 ⑥ 8번 보내도 반영되지 않으면 FAILED·failed_alerted_at·ops_alert SEV3 하나(7번째엔 0)이고, 반영되면 APPLIED·next_attempt_at NULL·경보 풀림·verification_case PASSED다', async () => {
    const { caseId } = await open();
    await run();
    stubs.queue.fail(grpc.status.UNAVAILABLE, 'ResolveVerificationAppeal');
    try {
      expect((await decide(identity.ops('cs_agent'), caseId, { outcome: 'ACCEPTED', resultNote: NOTE })).status).toBe(202);
      await expect.poll(async () => (await rowOf(caseId, 'QUEUE_RESOLVE'))?.attempts, { timeout: 10_000 }).toBe(1);
      const alerts = () => q<{ severity: string; resolved: boolean }>("select severity, resolved_at is not null as resolved from ops_alert where kind = 'CS_CASE_DISPATCH_FAILED' and detail->>'caseId' = $1", [caseId]);
      for (let n = 1; n < RETRY.failAfter; n++) {
        const due = (await rowOf(caseId, 'QUEUE_RESOLVE'))!.next_attempt_at!;
        // 다음 시각은 실패 시각 + 정본 간격이다(저장된 값으로 본다)
        expect([n, due.getTime() - clock.now()]).toEqual([n, waitAfterFailure(n)]);
        clock.advance(waitAfterFailure(n));
        await run();
        if (n + 1 < RETRY.failAfter) expect([n + 1, (await rowOf(caseId, 'QUEUE_RESOLVE'))!.state, (await alerts()).length]).toEqual([n + 1, 'PENDING', 0]);
      }
      const failed = (await rowOf(caseId, 'QUEUE_RESOLVE'))!;
      expect([failed.state, failed.attempts, failed.last_error, failed.failed_alerted_at !== null]).toEqual(['FAILED', 8, 'UNAVAILABLE', true]);
      expect(failed.next_attempt_at!.getTime() - clock.now()).toBe(RETRY.capMs);
      expect(await alerts()).toEqual([{ severity: 'SEV3', resolved: false }]);
      expect((await q<{ status: string }>('select status from verification_case where case_id = $1', [caseId]))[0]!.status).toBe('FAILED');
    } finally {
      stubs.queue.restore();
    }
    clock.advance(RETRY.capMs);
    await run();
    const ok = (await rowOf(caseId, 'QUEUE_RESOLVE'))!;
    expect([ok.state, ok.attempts, ok.next_attempt_at, ok.failed_alerted_at, ok.result]).toEqual(['APPLIED', 9, null, null, 'APPLIED']);
    expect(await q("select severity, resolved_at is not null as resolved from ops_alert where kind = 'CS_CASE_DISPATCH_FAILED' and detail->>'caseId' = $1", [caseId])).toEqual([{ severity: 'SEV3', resolved: true }]);
    expect((await q<{ status: string }>('select status from verification_case where case_id = $1', [caseId]))[0]!.status).toBe('PASSED');
  }, 60_000);

  test('B-T28 ⑥ 두 인스턴스의 배경 작업이 같은 때 돌아도(SKIP LOCKED·잡음) 보낼 때가 된 호출은 한 번만 보낸다', async () => {
    const { caseId } = await open();
    await run();
    stubs.queue.fail(grpc.status.UNAVAILABLE, 'ResolveVerificationAppeal');
    expect((await decide(identity.ops('cs_agent'), caseId, { outcome: 'REJECTED', resultNote: NOTE })).status).toBe(202);
    await expect.poll(async () => (await rowOf(caseId, 'QUEUE_RESOLVE'))?.attempts, { timeout: 10_000 }).toBe(1);
    const before = stubs.queue.count('ResolveVerificationAppeal');
    // real-time: 받는 쪽이 0.5초 늦게 답해 두 인스턴스의 한 바퀴가 실제로 겹친다 F-06-7
    stubs.queue.set('ResolveVerificationAppeal', () => new Promise((r) => setTimeout(() => r({ value: { result: 'RESOLVE_APPEAL_RESULT_APPLIED' } }), 500)));
    try {
      clock.advance(RETRY.firstMs);
      await Promise.all([run(svc1), run(svc2), run(svc1), run(svc2)]);
      expect(stubs.queue.count('ResolveVerificationAppeal') - before).toBe(1);
      expect((await rowOf(caseId, 'QUEUE_RESOLVE'))!.state).toBe('APPLIED');
    } finally {
      stubs.queue.restore();
    }
  }, 60_000);

  test('B-T28 ⑥ 잡은 쪽이 끝내지 못하고 잡음 시간(30초 [가정])이 지나면 다른 쪽이 다시 잡는다', async () => {
    const { caseId } = await open();
    await run();
    stubs.queue.fail(grpc.status.UNAVAILABLE, 'ResolveVerificationAppeal');
    try {
      expect((await decide(identity.ops('cs_agent'), caseId, { outcome: 'REJECTED', resultNote: NOTE })).status).toBe(202);
      await expect.poll(async () => (await rowOf(caseId, 'QUEUE_RESOLVE'))?.attempts, { timeout: 10_000 }).toBe(1);
      // 죽은 작업자가 잡아 둔 것처럼 claimed_until을 지금 + 30초로 둔다
      await admin.query("update cs_case_dispatch set claimed_until = $2, next_attempt_at = $3 where case_id = $1 and call = 'QUEUE_RESOLVE'", [caseId, new Date(clock.now() + 30_000), new Date(clock.now())]);
    } finally {
      stubs.queue.restore();
    }
    const before = stubs.queue.count('ResolveVerificationAppeal');
    clock.advance(30_000 - 1);
    await run(svc2);
    expect(stubs.queue.count('ResolveVerificationAppeal') - before).toBe(0);
    clock.advance(2);
    await run(svc2);
    expect(stubs.queue.count('ResolveVerificationAppeal') - before).toBe(1);
  }, 60_000);

  test('B-T10 ⑥ 다른 종류의 건은 보낼 호출 행이 생기지 않는다', async () => {
    const r = await svc1.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(caseRequest('DISPUTE')) });
    const caseId = String(parse(r.payload).caseId);
    expect(await dispatchRows(caseId)).toEqual([]);
    expect(await q('select 1 from verification_case where case_id = $1', [caseId])).toEqual([]);
  });
});
