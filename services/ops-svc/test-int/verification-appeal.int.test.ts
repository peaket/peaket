// 실서버 연결: 추가 검증 이의 처리 끝에서 끝(F-06-7 GAT-280, B-T10 ③④⑥, Q-T48 ②, B-T28 ③⑤⑥). 시험 담당 lane3-f067-test.
// 가짜로 끝내지 않는다. 띄우는 것:
// - ops-svc: 실제 PostgreSQL 18(migrateOps, 0031까지) + AppModule.register({ database, csAppeals }) + csAppealPortsFromEnv가 만든 실제 gRPC 클라이언트.
// - queue-svc: 실제 Valkey + 원본의 RedisVerificationStore·GetVerificationAppeal·ResolveVerificationAppeal·verificationAppealHandlers(실제 gRPC 서버).
//   이의는 원본 SubmitAppeal로 넣고(대기 참여는 B-T10 ④ 시험과 같은 조각으로 VERIFYING을 쓴다), 건 요청은 SubmitAppeal이 낸 값 그대로 ops-svc 내부 HTTP로 넣는다.
// - trust-svc: trust-svc/test-int/label-world.ts(실제 Valkey·실제 ApplyLabel·ScoreRisk) + 원본 trustLabelServiceHandlers·trustEvidenceServiceHandlers(GetVerdictEvidence)를 이 시험이 띄운 gRPC 서버에 건다.
//   차단 기기는 FRAUD_CONFIRMED BOT으로 올리고 그 기기로 사전 검증해 근거가 차단 목록인 추가 검증을 만든다(bot-review-label.int.test.ts·appeal-resolve.int.test.ts와 같은 길).
// - identity-svc: 같은 PostgreSQL 컨테이너의 다른 DB에 migrateIdentity, 원본 SetAccountHold + accountHoldHandlers(실제 gRPC 서버). 계정 행을 먼저 넣는다.
// 장애 주입은 그 gRPC 서버를 닫고(연결 실패) 같은 포트로 다시 띄운다. 순서 바꾸기는 실제 처리기 앞에 문을 두어 OPEN만 잠시 UNAVAILABLE로 돌린다.
// 시계: ops-svc는 가짜 시계(fakeClock, 지금 시각에서 시작)로 배경 작업 한 바퀴(CsCaseDispatchJob.runOnce)를 직접 돈다. gRPC 연결 재시도는 실제 시간이라 조건을 다시 묻는다(expect.poll).
// 정본: docs/features/bot-defense.md §12 'CS 처리 첫 구현'·'결과 반영', §9 '기록', queue-admission §11 Q-T48 ②, docs/data.md verification_case·cs_case_dispatch, identity.proto SetAccountHold.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { createDatabase, createHotRedis, createService, fakeClock, startGrpcServer, systemClock, type Database, type HotRedis, type StartedGrpcServer } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import * as casesModule from '../src/modules/cases/index.js';
import { NOTE, appealEnv, loadWiring } from '../test/cs-appeal-support.js';
import { logSink, testCalendar } from '../test/cs-support.js';
import { FakeIdentity } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
// queue-svc 원본(의존 선언 밖 상대 경로, CLAUDE.md '큰 그림' 끝: 그쪽을 고치면 ops-svc도 타입 검사한다)
import { keys as queueKeys } from '../../queue-svc/src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../../queue-svc/src/modules/entry/adapters/redis-event-schedules.js';
import { RedisVerificationStore } from '../../queue-svc/src/modules/verification/adapters/redis-verification-store.js';
import { GetVerificationAppeal, ResolveVerificationAppeal } from '../../queue-svc/src/modules/verification/application/appeals.js';
import { SubmitAppeal } from '../../queue-svc/src/modules/verification/application/submit-appeal.js';
import { queuePackage, verificationAppealHandlers } from '../../queue-svc/src/modules/verification/inbound/appeal.grpc.js';
import { openSchedule } from '../../queue-svc/test/support.js';
import { hashOf, numberDup, recordingCases, recordingLogger, recordingSignals, TEST_OPTIONS } from '../../queue-svc/test/verification-cases.js';
import { startValkey, type ValkeyContainer } from '../../queue-svc/test-int/valkey.js';
// trust-svc 원본
import { GetVerdictEvidence } from '../../trust-svc/src/modules/scoring/application/get-verdict-evidence.js';
import { trustEvidenceServiceHandlers } from '../../trust-svc/src/modules/scoring/inbound/evidence.grpc.js';
import { trustLabelServiceHandlers, trustPackage } from '../../trust-svc/src/modules/scoring/inbound/trust.grpc.js';
import { keys as trustKeys } from '../../trust-svc/src/modules/scoring/adapters/redis-feature-store.js';
import { dev, devicesV1, labelWorld, PSEUDONYMS, type LabelWorld } from '../../trust-svc/test-int/label-world.js';
// identity-svc 원본
import { migrateIdentity } from '../../identity-svc/scripts/migrate.mjs';
import { DrizzleSessionStore } from '../../identity-svc/src/modules/session/adapters/db/drizzle-session-store.js';
import { SetAccountHold } from '../../identity-svc/src/modules/session/application/set-account-hold.js';
import { accountHoldHandlers, identityPackage } from '../../identity-svc/src/modules/session/inbound/session.grpc.js';

const adminIdentity = new FakeIdentity();
const clock = fakeClock({ now: Date.now() });
const logs = logSink();
let container: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let admin: pg.Client;
let opsDb: Database;
let idDb: Database;
let qRedis: HotRedis;
let w: LabelWorld;
let svc: Awaited<ReturnType<typeof createService>>;
let ports: { close(): void } | undefined;
let wiringMissing = false;

/** 다시 띄울 수 있는 실제 gRPC 서버(같은 포트). gate가 정하면 실제 처리기 앞에서 그 상태로 답한다 */
interface RealServer {
  readonly name: string;
  port: number;
  server: StartedGrpcServer | undefined;
  /** 메서드별로 실제 처리기에 닿은 수 */
  readonly reached: Map<string, number>;
  gate: ((method: string, req: Record<string, unknown>) => grpc.status | undefined) | undefined;
  delayMs: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function realServer(name: string, bindings: () => Array<{ definition: grpc.ServiceDefinition; handlers: grpc.UntypedServiceImplementation }>): RealServer {
  const s: RealServer = {
    name,
    port: 0,
    server: undefined,
    reached: new Map(),
    gate: undefined,
    delayMs: 0,
    async start() {
      const services = bindings().map((b) => {
        const handlers: grpc.UntypedServiceImplementation = {};
        for (const [m, real] of Object.entries(b.handlers)) {
          const h: grpc.handleUnaryCall<Record<string, unknown>, unknown> = (call, cb) => {
            const code = s.gate?.(m, call.request);
            if (code !== undefined) return cb({ code, details: '시험 문' });
            const go = () => {
              s.reached.set(m, (s.reached.get(m) ?? 0) + 1);
              (real as grpc.handleUnaryCall<Record<string, unknown>, unknown>)(call, cb);
            };
            // real-time: 겹쳐 보내기 시험에서 실제 처리기가 늦게 답하게 한다(gRPC는 실제 시계) F-06-7
            if (s.delayMs > 0) setTimeout(go, s.delayMs);
            else go();
          };
          handlers[m] = h;
        }
        return { definition: b.definition, handlers };
      });
      s.server = await startGrpcServer({ host: '127.0.0.1', port: s.port, profile: 'service', drainMs: 0, services });
      s.port = s.server.port;
    },
    async stop() {
      await s.server?.close();
      s.server = undefined;
    },
  };
  return s;
}

let queueSrv: RealServer;
let trustSrv: RealServer;
let identitySrv: RealServer;

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  await admin.query('create database identity_f067');
  const idUrl = container.url.replace(/\/peaket$/, '/identity_f067');
  await migrateIdentity(idUrl);
  idDb = createDatabase({ url: idUrl, applicationName: 'identity-f067-it' });
  opsDb = createDatabase({ url: container.url, applicationName: 'ops-svc-f067-it' });

  valkey = await startValkey();
  qRedis = await createHotRedis({ url: valkey.url });
  w = await labelWorld(valkey.url);

  const qStore = new RedisVerificationStore(qRedis);
  queueSrv = realServer('queue', () => [
    { definition: queuePackage().VerificationAppealService.service, handlers: verificationAppealHandlers({ get: new GetVerificationAppeal(qStore), resolve: new ResolveVerificationAppeal(qStore, systemClock, recordingLogger().logger) }, () => undefined) },
  ]);
  trustSrv = realServer('trust', () => [
    { definition: trustPackage().TrustLabelService.service, handlers: trustLabelServiceHandlers(w.apply, () => undefined) },
    { definition: trustPackage().TrustEvidenceService.service, handlers: trustEvidenceServiceHandlers(new GetVerdictEvidence({ store: w.features, clock: systemClock }), () => undefined) },
  ]);
  const sessions = new DrizzleSessionStore(idDb, systemClock);
  identitySrv = realServer('identity', () => [{ definition: identityPackage().AccountHoldService.service, handlers: accountHoldHandlers({ hold: new SetAccountHold(sessions, systemClock) }, () => undefined) }]);
  await Promise.all([queueSrv.start(), trustSrv.start(), identitySrv.start()]);

  const env = appealEnv({ addresses: { queue: `127.0.0.1:${queueSrv.port}`, trust: `127.0.0.1:${trustSrv.port}`, identity: `127.0.0.1:${identitySrv.port}` } }, { env: 'ci' });
  const wiring = await loadWiring();
  wiringMissing = !wiring;
  const made = wiring?.csAppealPortsFromEnv(env);
  ports = made;
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({
      database: opsDb,
      calendar: testCalendar(),
      background: false,
      ...(made ? { csAppeals: { ...(made.appeals ? { appeals: made.appeals } : {}), ...(made.labels ? { labels: made.labels } : {}), ...(made.evidence ? { evidence: made.evidence } : {}), ...(made.holds ? { holds: made.holds } : {}) } } : {}),
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: logs.stream,
    adminAuthz: adminIdentity,
  });
}, 240_000);

afterAll(async () => {
  await svc?.close();
  ports?.close();
  await Promise.all([queueSrv?.stop(), trustSrv?.stop(), identitySrv?.stop()]);
  await w?.close();
  await qRedis?.close();
  await opsDb?.close();
  await idDb?.close();
  await admin?.end().catch(() => undefined);
  valkey?.stop();
  container?.stop();
});

const q = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => admin.query<T>(text, params).then((r) => r.rows);
const idq = async <T,>(text: string, params: unknown[] = []) => (await idDb.pool.query(text, params)).rows as T[];
const parse = (payload: string): Record<string, unknown> => (payload ? (JSON.parse(payload) as Record<string, unknown>) : {});

async function runDispatch(): Promise<void> {
  const Job = casesModule.CsCaseDispatchJob;
  if (!Job) throw new Error(`CsCaseDispatchJob이 없다(계획 §4)${wiringMissing ? ', cs-appeal-wiring.ts도 없다' : ''}`);
  await svc.app.get(Job).runOnce();
}

async function detail(caseId: string, role: 'cs_agent' | 'operator' = 'cs_agent') {
  const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/cases/${caseId}`, headers: adminIdentity.ops(role) });
  expect(r.statusCode, r.payload).toBe(200);
  return { raw: r.payload, body: parse(r.payload), va: (parse(r.payload).verificationAppeal ?? {}) as Record<string, unknown> };
}

async function decide(who: Record<string, string>, caseId: string, outcome: 'ACCEPTED' | 'REJECTED', ifMatch = '"1"') {
  const r = await svc.http.inject({
    method: 'POST',
    url: `/v1/ops/cases/${caseId}/verification-appeal-decision`,
    headers: { ...who, 'content-type': 'application/json', 'if-match': ifMatch, 'idempotency-key': randomUUID() },
    payload: JSON.stringify({ outcome, resultNote: NOTE }),
  });
  return { status: r.statusCode, body: parse(r.payload) };
}

/** 배경 작업을 돌리며(시계 10분씩) 그 호출이 반영될 때까지 다시 묻는다. 끊긴 gRPC 연결이 실제 시간으로 다시 붙는 동안을 기다린다 */
async function untilApplied(caseId: string, calls: readonly string[]): Promise<void> {
  await expect
    .poll(
      async () => {
        clock.advance(600_000);
        await runDispatch();
        const rows = ((await detail(caseId)).va.dispatch ?? []) as Array<{ call: string; state: string }>;
        return calls.map((c) => rows.find((r) => r.call === c)?.state ?? 'MISSING');
      },
      { timeout: 60_000, interval: 300 },
    )
    .toEqual(calls.map(() => 'APPLIED'));
}

let deviceSeq = 0;
/** 이 회차에 VERIFYING 대기 참여를 만들고 실제 SubmitAppeal로 이의를 넣은 뒤, 그 건 요청을 ops-svc 내부 HTTP로 넣는다 */
async function appealOf(o: { blocked?: boolean; text?: string } = {}) {
  const eventId = randomUUID();
  const accountId = randomUUID();
  const pid = `pid-f067-it-${randomUUID().slice(0, 8)}`;
  let deviceRef: string | undefined;
  if (o.blocked) {
    // 차단 기기: 다른 사람의 판정을 CS가 부정 구매로 확인(FRAUD_CONFIRMED BOT) → 그 기기로 이 사람이 사전 검증하면 확정 신호 차단 목록으로 CHALLENGE
    const device = `f067blk${++deviceSeq}`;
    const seedEvent = randomUUID();
    const seed = `pid-f067-seed-${deviceSeq}`;
    w.human.set('FAILED');
    expect(await w.scoreRisk({ pid: seed, device_id: dev(device), event_id: seedEvent })).toMatchObject({ verdict: 'VERDICT_CHALLENGE' });
    w.human.set('PASSED');
    expect(await w.applyLabel({ source_ref: `f067-seed-${deviceSeq}`, source: 'LABEL_SOURCE_FRAUD_CONFIRMED', label: 'LABEL_BOT', event_id: seedEvent, pid: seed, review_batch: undefined, applied_verdict: undefined })).toEqual({
      changed: true,
      block_list: 'BLOCK_LIST_CHANGE_ADDED',
    });
    expect(await w.scoreRisk({ pid, device_id: dev(device), event_id: eventId })).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_DEVICE_HISTORY' });
    deviceRef = devicesV1.ref(dev(device))!;
    expect(await w.cmd(['EXISTS', trustKeys.block(deviceRef)])).toBe(1);
  }
  // queue-svc: 회차 설정과 VERIFYING 대기 참여(appeal-resolve.int.test.ts B-T10 ④와 같은 조각)
  const schedule = openSchedule(Date.now(), { lobbyShuffle: false, openBatch: true, batchWindowMs: 1 });
  const qc = (key: string, args: string[]) => qRedis.command(args, { key, deadlineMs: 5_000 });
  await qc(queueKeys.cfg(eventId), ['HSET', queueKeys.cfg(eventId), 'opensAtMs', String(schedule.opensAtMs), 'startsAtMs', String(schedule.startsAtMs), 'lobbyShuffle', '0', 'openBatch', '1', 'batchWindowMs', '1', 'rev', '1']);
  const ticket = hashOf(`f067-${eventId}`);
  await qc(queueKeys.dup(pid, eventId), ['SET', queueKeys.dup(pid, eventId), numberDup(3, ticket)]);
  await qc(queueKeys.verify(eventId), ['HSET', queueKeys.verify(eventId), ticket, `VERIFYING:${Date.now()}:DEVICE_HISTORY`]);
  const cases = recordingCases('ok');
  const out = await new SubmitAppeal(new RedisVerificationStore(qRedis), new RedisEventSchedules(qRedis, systemClock), cases, TEST_OPTIONS, systemClock, recordingSignals()).run({ eventId, accountId, pid, text: o.text ?? '사람입니다 <script>x</script>' });
  if (out.kind !== 'RECEIVED') throw new Error('이의가 접수되지 않았다');
  expect(cases.delivered).toHaveLength(1);
  const req = cases.delivered[0]!;
  // identity-svc: 그 계정
  await idDb.pool.query("insert into account (id, status, email, email_verified, created_at) values ($1, 'ACTIVE', $2, true, now())", [accountId, `${accountId}@f067.test`]);
  const body = { eventKey: req.eventKey, kind: 'VERIFICATION_APPEAL', sourceId: req.sourceId, category: req.category, createdAt: new Date(req.createdAtMs).toISOString() };
  const intake = await svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  expect(intake.statusCode, intake.payload).toBe(202);
  const caseId = String(parse(intake.payload).caseId);
  return { eventId, accountId, pid, appealId: out.appealId, caseId, deviceRef, ticket, intakeBody: body };
}

const hold = async (caseId: string) => idq<{ state: string; source_version: string; kind: string; account_id: string }>('select state, source_version::text as source_version, kind, account_id from account_hold where source_ref = $1', [caseId]);
const verifyField = async (eventId: string, ticket: string) => String(await qRedis.command(['HGET', queueKeys.verify(eventId), ticket], { key: queueKeys.verify(eventId), deadlineMs: 5_000 }));

describe('0031 마이그레이션', () => {
  test('B-T28 ⑥ 0031이 적용되고 verification_case·cs_case_dispatch가 data.md 칸·기본 키 (case_id, call)·보낼 호출 부분 인덱스를 갖는다', async () => {
    expect((await q<{ name: string }>("select name from ops_migration where name like '0031_%'")).map((r) => r.name)).toEqual(['0031_verification_appeal_dispatch.sql']);
    const cols = async (t: string) => (await q<{ column_name: string }>('select column_name from information_schema.columns where table_name = $1 order by column_name', [t])).map((r) => r.column_name);
    expect(await cols('verification_case')).toEqual(
      ['account_id', 'appeal_result', 'appeal_text', 'block_list_change', 'case_id', 'created_at', 'decided_at', 'decided_by', 'event_id', 'id', 'pid', 'reason_category', 'received_at', 'status', 'updated_at'].sort(),
    );
    expect(await cols('cs_case_dispatch')).toEqual(['attempts', 'call', 'case_id', 'claimed_until', 'created_at', 'failed_alerted_at', 'last_error', 'next_attempt_at', 'result', 'source_version', 'state', 'updated_at'].sort());
    const pk = await q<{ cols: string }>(
      "select string_agg(a.attname, ',' order by array_position(i.indkey, a.attnum)) as cols from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = 'cs_case_dispatch'::regclass and i.indisprimary",
    );
    expect(pk).toEqual([{ cols: 'case_id,call' }]);
    const idx = await q<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'cs_case_dispatch' and indexdef ilike '%(next_attempt_at)%'");
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toMatch(/WHERE \(state <> 'APPLIED'::text\)/);
    const uniq = await q<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'verification_case' and indexdef ilike '%unique%(case_id)%'");
    expect(uniq).toHaveLength(1);
  });
});

describe('B-T10 ③ Q-T48 ② 인정 끝에서 끝(실제 queue·trust·identity)', () => {
  test('B-T10 ③ Q-T48 ② B-T28 ③ 차단 기기로 걸린 사람의 이의를 인정하면 queue PASSED, tr:block 키 지움, LABELED_HUMAN 하나, identity CLOSED이고 건에 처리자·시각·REMOVED가 남으며 기기 가명은 어디에도 없다', async () => {
    const a = await appealOf({ blocked: true });
    const labelsBefore = w.offered.filter((o) => o.value.category === 'LABELED_HUMAN').length;
    await runDispatch();
    expect(await hold(a.caseId)).toEqual([{ state: 'OPEN', source_version: '1', kind: 'VERIFICATION_APPEAL', account_id: a.accountId }]);
    const before = await detail(a.caseId);
    expect(before.va).toMatchObject({ content: 'AVAILABLE', entryState: 'VERIFYING', reasonCategory: 'DEVICE_HISTORY', evidence: { state: 'FOUND', hardSignal: 'BLOCK_LIST', source: 'REALTIME' } });
    const agent = adminIdentity.ops('cs_agent');
    const decidedAt = new Date(clock.now()).toISOString();
    expect((await decide(agent, a.caseId, 'ACCEPTED')).status).toBe(202);
    await untilApplied(a.caseId, ['QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE']);
    // queue-svc: PASSED(이의 인정 통과)
    expect(await verifyField(a.eventId, a.ticket)).toMatch(/^PASSED:/);
    expect((await new GetVerificationAppeal(new RedisVerificationStore(qRedis)).run(a.appealId)).entryState).toBe('PASSED');
    // trust-svc: 차단 키가 지워지고 보안 로그 줄(건 ID·처리자의 로그 가명), 라벨 LABELED_HUMAN 하나
    expect(await w.cmd(['EXISTS', trustKeys.block(a.deviceRef!)])).toBe(0);
    const lines = w.logLines.filter((l) => l.event === 'trust_block_list_change' && l.caseId === a.caseId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ caseId: a.caseId, accountRef: PSEUDONYMS.ref(agent['x-user-id']!) });
    expect(JSON.stringify(lines)).not.toContain(a.deviceRef!);
    expect(JSON.stringify(lines)).not.toContain(agent['x-user-id']!);
    expect(w.offered.filter((o) => o.value.category === 'LABELED_HUMAN').length).toBe(labelsBefore + 1);
    // identity-svc: CLOSED, 새 판
    expect(await hold(a.caseId)).toEqual([{ state: 'CLOSED', source_version: '2', kind: 'VERIFICATION_APPEAL', account_id: a.accountId }]);
    // ops-svc: 건 상세와 표
    const after = await detail(a.caseId);
    expect(after.va).toMatchObject({ entryState: 'PASSED', decision: { outcome: 'ACCEPTED', decidedBy: agent['x-user-id'], decidedAt, blockListChange: 'REMOVED' }, reflectState: 'APPLIED' });
    const row = await q<{ status: string; appeal_result: string; block_list_change: string; decided_by: string; pid: string; event_id: string; account_id: string }>(
      'select status, appeal_result, block_list_change, decided_by::text as decided_by, pid, event_id::text as event_id, account_id::text as account_id from verification_case where case_id = $1',
      [a.caseId],
    );
    expect(row).toEqual([{ status: 'PASSED', appeal_result: 'ACCEPTED', block_list_change: 'REMOVED', decided_by: agent['x-user-id'], pid: a.pid, event_id: a.eventId, account_id: a.accountId }]);
    // 기기 가명은 ops-svc 응답·로그에 없다. pid·계정 ID도 응답·로그에 없다
    for (const secret of [a.deviceRef!, a.pid, a.accountId]) {
      expect(after.raw).not.toContain(secret);
      expect(JSON.stringify(logs.lines())).not.toContain(secret);
    }
  }, 120_000);

  test('B-T28 ③ 근거가 차단 목록이 아닌 사람의 인정은 키를 바꾸지 않고 건에 그 차단 목록 변화가 남는다', async () => {
    const a = await appealOf();
    const blocks = await w.keysLike('tr:block:*');
    await runDispatch();
    expect((await decide(adminIdentity.ops('cs_lead'), a.caseId, 'ACCEPTED')).status).toBe(202);
    await untilApplied(a.caseId, ['QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE']);
    expect(await w.keysLike('tr:block:*')).toEqual(blocks);
    // 판정 근거 키가 없는 사람(사전 검증을 거치지 않은 시험 참여)이라 기기를 찾지 못한다
    expect(((await detail(a.caseId)).va.decision as Record<string, unknown>).blockListChange).toBe('DEVICE_NOT_FOUND');
  }, 120_000);
});

describe('B-T10 ④ 기각 끝에서 끝', () => {
  test('B-T10 ④ B-T28 ④ 기각하면 queue BLOCKED로 끝나고 trust 라벨 기록(tr:lbl)이 없으며 identity CLOSED다', async () => {
    const a = await appealOf({ blocked: true });
    await runDispatch();
    expect((await decide(adminIdentity.ops('cs_agent'), a.caseId, 'REJECTED')).status).toBe(202);
    await untilApplied(a.caseId, ['QUEUE_RESOLVE', 'ACCOUNT_HOLD_CLOSE']);
    clock.advance(3_600_000);
    await runDispatch();
    expect(await verifyField(a.eventId, a.ticket)).toMatch(/^BLOCKED:/);
    expect(await w.keysLike(`tr:lbl:{${a.caseId}}*`)).toEqual([]);
    expect(await w.cmd(['EXISTS', trustKeys.block(a.deviceRef!)])).toBe(1);
    expect(await hold(a.caseId)).toEqual([{ state: 'CLOSED', source_version: '2', kind: 'VERIFICATION_APPEAL', account_id: a.accountId }]);
    // 시험 리뷰 1 TR-12 반영: 공유 서버의 전체 호출 수를 견주지 않는다. 이 건의 라벨 기록(tr:lbl:{건 ID})이 없는 것으로 본다(위 줄)
    expect((await q<{ status: string; appeal_result: string; block_list_change: string | null }>('select status, appeal_result, block_list_change from verification_case where case_id = $1', [a.caseId]))[0]).toEqual({
      status: 'PASSED',
      appeal_result: 'REJECTED',
      block_list_change: null,
    });
  }, 120_000);
});

describe('B-T28 ⑤ 실제 identity의 판 비교', () => {
  test('B-T28 ⑤ OPEN(판 1)이 못 간 채 결정해 CLOSED(판 2)가 먼저 반영되고 OPEN이 늦게 닿아도 account_hold는 CLOSED·판 2다', async () => {
    const a = await appealOf();
    let openGate = true;
    identitySrv.gate = (m, req) => (m === 'SetAccountHold' && req.state === 'ACCOUNT_HOLD_STATE_OPEN' && openGate ? grpc.status.UNAVAILABLE : undefined);
    try {
      await runDispatch();
      expect(await hold(a.caseId)).toEqual([]);
      expect((await decide(adminIdentity.ops('cs_agent'), a.caseId, 'ACCEPTED')).status).toBe(202);
      await untilApplied(a.caseId, ['ACCOUNT_HOLD_CLOSE']);
      expect(await hold(a.caseId)).toEqual([{ state: 'CLOSED', source_version: '2', kind: 'VERIFICATION_APPEAL', account_id: a.accountId }]);
      openGate = false;
      await untilApplied(a.caseId, ['ACCOUNT_HOLD_OPEN']);
      expect(await hold(a.caseId)).toEqual([{ state: 'CLOSED', source_version: '2', kind: 'VERIFICATION_APPEAL', account_id: a.accountId }]);
    } finally {
      identitySrv.gate = undefined;
    }
  }, 120_000);
});

describe('B-T28 ⑥ 실제 서버를 하나씩 멈춘 채 결정', () => {
  for (const which of ['queue', 'trust', 'identity'] as const) {
    test(`B-T28 ⑥ B-T10 ⑥ ${which}-svc를 멈춘 채 결정해도 202·저장이고, 같은 포트로 되살린 뒤 배경 작업이 같은 건 ID·판으로 보내 실제 상태가 한 번만 바뀐다`, async () => {
      const a = await appealOf({ blocked: which === 'trust' });
      await runDispatch();
      const srv = { queue: queueSrv, trust: trustSrv, identity: identitySrv }[which];
      const call = { queue: 'QUEUE_RESOLVE', trust: 'TRUST_LABEL', identity: 'ACCOUNT_HOLD_CLOSE' }[which];
      const offeredBefore = w.offered.filter((o) => o.value.category === 'LABELED_HUMAN').length;
      await srv.stop();
      try {
        const r = await decide(adminIdentity.ops('cs_agent'), a.caseId, 'ACCEPTED');
        expect([r.status, r.body.status, r.body.version]).toEqual([202, 'RESOLVED', 2]);
        expect((await q<{ status: string; version: string }>('select status, version::text as version from cs_case where id = $1', [a.caseId]))[0]).toEqual({ status: 'RESOLVED', version: '2' });
        clock.advance(10_000);
        await runDispatch();
        const pending = ((await detail(a.caseId)).va.dispatch as Array<{ call: string; state: string; lastError: string | null; attempts: number }>).find((d) => d.call === call)!;
        expect([pending.state, pending.lastError]).toEqual(['PENDING', 'UNAVAILABLE']);
        expect(pending.attempts).toBeGreaterThanOrEqual(1);
      } finally {
        await srv.start();
      }
      await untilApplied(a.caseId, ['QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE']);
      clock.advance(3_600_000);
      await runDispatch();
      // 실제 상태가 한 번만 바뀌었다(같은 판)
      expect(await verifyField(a.eventId, a.ticket)).toMatch(/^PASSED:/);
      const cv = await qRedis.command(['HGET', `q:appeal:{${a.pid}}:${a.eventId}`, 'cv'], { key: `q:appeal:{${a.pid}}:${a.eventId}`, deadlineMs: 5_000 });
      expect(String(cv)).toBe('2');
      expect(await hold(a.caseId)).toEqual([{ state: 'CLOSED', source_version: '2', kind: 'VERIFICATION_APPEAL', account_id: a.accountId }]);
      expect(w.offered.filter((o) => o.value.category === 'LABELED_HUMAN').length).toBeGreaterThanOrEqual(offeredBefore + 1);
      if (which === 'trust') {
        expect(await w.cmd(['EXISTS', trustKeys.block(a.deviceRef!)])).toBe(0);
        expect(w.logLines.filter((l) => l.event === 'trust_block_list_change' && l.caseId === a.caseId)).toHaveLength(1);
      }
      expect((await q<{ n: string }>("select count(*)::text as n from ops_alert where kind = 'CS_CASE_DISPATCH_FAILED' and resolved_at is null and detail->>'caseId' = $1", [a.caseId]))[0]!.n).toBe('0');
    }, 120_000);
  }
});

describe('B-T10 ⑥ 처리함에 건이 하나', () => {
  test('B-T10 ⑥ 같은 이의의 건 요청이 다시 와도(같은 eventKey) cs_case·verification_case·보낼 호출이 한 벌이다', async () => {
    const a = await appealOf();
    for (let i = 0; i < 2; i++) {
      const again = await svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(a.intakeBody) });
      expect(again.statusCode).toBe(202);
    }
    expect((await q<{ n: string }>("select count(*)::text as n from cs_case where kind = 'VERIFICATION_APPEAL' and target_ref = $1", [a.appealId]))[0]!.n).toBe('1');
    expect((await q<{ n: string }>('select count(*)::text as n from verification_case where id = $1', [a.appealId]))[0]!.n).toBe('1');
    expect((await q<{ call: string; source_version: string }>('select call, source_version::text as source_version from cs_case_dispatch where case_id = $1 order by call', [a.caseId]))).toEqual([
      { call: 'ACCOUNT_HOLD_OPEN', source_version: '1' },
      { call: 'APPEAL_COPY', source_version: '1' },
    ]);
    await runDispatch();
    expect(identitySrv.reached.get('SetAccountHold')).toBeGreaterThan(0);
    expect(await hold(a.caseId)).toEqual([{ state: 'OPEN', source_version: '1', kind: 'VERIFICATION_APPEAL', account_id: a.accountId }]);
  }, 120_000);
});
