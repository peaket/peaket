// CS 처리함 실제 PostgreSQL 18 통합 시험(F-06-2 GAT-280, R-T48 ①②, R-T49 ③④⑥, R-T50 ②③⑤, R-T51 화면 ↔ 서버). 시험 담당 lane3-f062-test.
// createService + 실제 마이그레이션(0030 포함) + Drizzle 저장소로 내부 HTTP·관제 HTTP·기한 알림 작업(배경 조립 포함)·정의자 함수 새 서명을 돈다.
// 정본: docs/data.md cs_case·cs_case_request·§5 'CS 처리함(ops)' 행(next_due_at NOT NULL 'infinity', (next_due_at, id) 인덱스),
// ADR-0364 결정 1~5, docs/features/transfer-refund.md §11 R-T48~R-T51, docs/api/guidelines.md '동시 수정'. 공휴일은 시험이 만든 날(2026-11-25 수)이다.
// 세션은 ops-svc 시험들이 쓰는 FakeIdentity다. 컨테이너는 afterAll에서 지운다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { CsCaseDeadlineTick, type CsCaseKit } from '../src/modules/cases/index.js';
import { casePageOf, caseViewOf, errorOf, ifMatchOf, versionOfEtag } from '../../../apps/console-host/src/pages/cs-inbox/model/live.js';
import { BASE_ISO, BD1, BD10, BD3, caseRequest, testCalendar } from '../test/cs-support.js';
import { caught, screenApi } from '../test/cs-screen-api.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const identity = new FakeIdentity();
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
let kit: CsCaseKit;
const clock = fakeClock({ now: Date.parse(BASE_ISO) });

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-cs-cases-it' });
  svc = await createService({
    name: 'ops-svc',
    // 배경 작업 간격은 코드 기본값(1분)과 다른 값으로 조립한다(배경 조립이 실제로 도는지 본다)
    module: AppModule.register({ database: db, calendar: testCalendar(), background: { csCaseDeadlineMs: 150 } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  kit = svc.app.get<CsCaseKit>(Symbol.for('peaket.ops.cs-case-kit'));
}, 180_000);

afterAll(async () => {
  await svc?.close();
  await db?.close();
  await admin?.end().catch(() => undefined);
  container?.stop();
});

const q = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => admin.query<T>(text, params).then((r) => r.rows);
const intake = async (body: unknown) => {
  const r = await svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  expect(r.statusCode, r.payload).toBe(202);
  return JSON.parse(r.payload) as { accepted: boolean; caseId?: string };
};
const patch = (h: Record<string, string>, id: string, body: unknown, ifMatch: string) =>
  svc.http.inject({ method: 'PATCH', url: `/v1/ops/cases/${id}`, headers: { ...h, 'content-type': 'application/json', 'if-match': ifMatch }, payload: JSON.stringify(body) });
const list = async (h: Record<string, string>, query: string) => {
  const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/cases?${query}`, headers: h });
  expect(r.statusCode, r.payload).toBe(200);
  return JSON.parse(r.payload) as { items: Array<Record<string, string>>; nextCursor: string | null };
};
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());

describe('0030 마이그레이션 [R-T48 ① R-T49 ⑥]', () => {
  test('R-T48 ① 0030이 적용되고 cs_case에 data.md의 칸이, cs_case_request 표와 (next_due_at, id) 부분 인덱스가 있다', async () => {
    expect((await q<{ name: string }>("select name from ops_migration where name like '0030_%'")).map((r) => r.name)).toEqual(['0030_cs_case_deadlines.sql']);
    const cols = (await q<{ column_name: string; is_nullable: string; is_generated: string }>("select column_name, is_nullable, is_generated from information_schema.columns where table_name = 'cs_case'")).reduce<Record<string, { nullable: string; generated: string }>>(
      (m, c) => ({ ...m, [c.column_name]: { nullable: c.is_nullable, generated: c.is_generated } }),
      {},
    );
    for (const c of ['category', 'progress_due_at', 'result_due_at', 'next_due_at', 'assignee', 'version', 'result_note', 'resolved_at', 'due_soon_alerted_for', 'overdue_alerted_for']) expect(cols[c], c).toBeDefined();
    expect(cols.next_due_at).toEqual({ nullable: 'NO', generated: 'ALWAYS' });
    expect(cols.version!.nullable).toBe('NO');
    const reqCols = (await q<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'cs_case_request' order by column_name")).map((r) => r.column_name);
    expect(reqCols).toEqual(['case_id', 'event_key', 'kind', 'received_at']);
    const idx = await q<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'cs_case' and indexdef ilike '%(next_due_at, id)%'");
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toMatch(/WHERE \(status <> 'RESOLVED'::text\)/);
  });

  test('R-T49 ⑥ next_due_at은 두 기한 중 이른 것이고 둘 다 없으면 infinity다(생성 열)', async () => {
    const put = async (p: string | null, r: string | null) => {
      const id = randomUUID();
      await q("insert into cs_case (id, kind, target_ref, status, progress_due_at, result_due_at, created_at, updated_at) values ($1, 'DISPUTE', $2, 'OPEN', $3, $4, now(), now())", [id, `gen-${id}`, p, r]);
      return (await q<{ v: string }>('select next_due_at::text as v from cs_case where id = $1', [id]))[0]!.v;
    };
    expect(new Date(await put(BD3, BD10)).toISOString()).toBe(BD3);
    expect(new Date(await put(null, BD1)).toISOString()).toBe(BD1);
    expect(await put(null, null)).toBe('infinity');
    await expect(q("update cs_case set next_due_at = now() where kind = 'DISPUTE'")).rejects.toThrow();
  });

  test('R-T49 ④ 결과 메모는 1~2,000자이고(CHECK) eventKey는 한 번만 적힌다(cs_case_request 기본 키)', async () => {
    const id = randomUUID();
    await q("insert into cs_case (id, kind, target_ref, status, created_at, updated_at) values ($1, 'DISPUTE', $2, 'OPEN', now(), now())", [id, `note-${id}`]);
    await expect(q("update cs_case set result_note = '' where id = $1", [id])).rejects.toThrow(/cs_case_result_note_check/);
    await expect(q('update cs_case set result_note = $2 where id = $1', [id, '가'.repeat(2001)])).rejects.toThrow(/cs_case_result_note_check/);
    await expect(q('update cs_case set result_note = $2 where id = $1', [id, '가'.repeat(2000)])).resolves.toEqual([]);
    const key = `evt-${randomUUID()}`;
    await q("insert into cs_case_request (event_key, case_id, kind, received_at) values ($1, $2, 'DISPUTE', now())", [key, id]);
    await expect(q("insert into cs_case_request (event_key, case_id, kind, received_at) values ($1, $2, 'DISPUTE', now())", [key, id])).rejects.toThrow(/cs_case_request_pkey|duplicate key/);
  });
});

describe('실제 DB 위 건 받기 [R-T48 ①②]', () => {
  test('R-T48 ① 내부 HTTP로 받은 건이 DB에 두 기한·category와 eventKey 한 줄로 남는다', async () => {
    const body = caseRequest('DISPUTE', { category: 'INQUIRY_DISPUTE' });
    const r = await intake(body);
    const row = (await q<Record<string, unknown>>('select kind, status, category, progress_due_at, result_due_at, next_due_at, version from cs_case where id = $1', [r.caseId]))[0]!;
    expect({ ...row, progress_due_at: iso(row.progress_due_at), result_due_at: iso(row.result_due_at), next_due_at: iso(row.next_due_at), version: Number(row.version) }).toEqual({
      kind: 'DISPUTE',
      status: 'OPEN',
      category: 'INQUIRY_DISPUTE',
      progress_due_at: BD3,
      result_due_at: BD10,
      next_due_at: BD3,
      version: 1,
    });
    expect(await q('select case_id, kind from cs_case_request where event_key = $1', [body.eventKey])).toEqual([{ case_id: r.caseId, kind: 'DISPUTE' }]);
  });

  test('R-T48 ② 같은 eventKey·같은 대상의 다른 eventKey는 같은 건이고, 해결된 건의 같은 eventKey는 새 행 0이다', async () => {
    const body = caseRequest('REFUND_FAILED', { category: 'REFUND' });
    const a = await intake(body);
    expect(await intake(body)).toEqual({ accepted: true, caseId: a.caseId });
    const other = { ...body, eventKey: randomUUID() };
    expect(await intake(other)).toEqual({ accepted: true, caseId: a.caseId });
    const agent = identity.ops('cs_agent');
    expect((await patch(agent, a.caseId!, { status: 'RESOLVED', resultNote: '재처리 완료' }, '"1"')).statusCode).toBe(200);
    expect(await intake(body)).toEqual({ accepted: true, caseId: a.caseId });
    expect(await intake(other)).toEqual({ accepted: true, caseId: a.caseId });
    expect((await q<{ n: string }>("select count(*)::text as n from cs_case where kind = 'REFUND_FAILED' and target_ref = $1", [body.sourceId]))[0]!.n).toBe('1');
    expect((await q<{ n: string }>('select count(*)::text as n from cs_case_request where case_id = $1', [a.caseId]))[0]!.n).toBe('2');
  });

  test('R-T48 ③ INQUIRY도 cs_case·cs_case_request 행을 만든다(F-06-5)', async () => {
    const body = caseRequest('INQUIRY');
    const r = await intake(body);
    expect(r.accepted).toBe(true);
    expect(r.caseId).toBeTruthy();
    expect((await q<{ n: string }>("select count(*)::text as n from cs_case where kind = 'INQUIRY' and target_ref = $1", [body.sourceId]))[0]!.n).toBe('1');
    expect((await q<{ n: string }>('select count(*)::text as n from cs_case_request where event_key = $1', [body.eventKey]))[0]!.n).toBe('1');
    expect((await q<{ account_id: string | null }>('select account_id from cs_case where id = $1', [r.caseId!]))[0]!.account_id).toBeNull();
  });

  test('IR-11 TICKET_NOT_ISSUED도 DB에 건을 만든다', async () => {
    const body = caseRequest('TICKET_NOT_ISSUED');
    const r = await intake(body);
    expect(r.accepted).toBe(true);
    expect(r.caseId).toBeTruthy();
    expect((await q<{ n: string }>("select count(*)::text as n from cs_case where kind = 'TICKET_NOT_ISSUED' and target_ref = $1", [body.sourceId]))[0]!.n).toBe('1');
  });
});

describe('실제 DB 위 갱신 [R-T49 ③④⑥]', () => {
  test('R-T49 ③ 같은 판으로 두 갱신을 동시에 보내면 하나만 200이고 하나는 412이며 판은 1만 오른다', async () => {
    const id = (await intake(caseRequest('DISPUTE'))).caseId!;
    const a = identity.ops('cs_agent');
    const b = identity.ops('cs_agent');
    const [x, y] = await Promise.all([patch(a, id, { assignee: a['x-user-id'] }, '"1"'), patch(b, id, { assignee: b['x-user-id'] }, '"1"')]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 412]);
    const row = (await q<{ version: string; assignee: string }>('select version::text as version, assignee from cs_case where id = $1', [id]))[0]!;
    expect(row.version).toBe('2');
    expect([a['x-user-id'], b['x-user-id']]).toContain(row.assignee);
    // 갱신마다 감사 체인에 한 줄(이긴 쪽만)
    expect((await q<{ n: string }>("select count(*)::text as n from audit_chain where record_type = 'CS_CASE_UPDATED' and record_id = $1", [id]))[0]!.n).toBe('1');
  });

  test('R-T49 ④ 해결은 resolved_at을 남기고 다시 고치면 409이며 DB 행이 그대로다', async () => {
    const id = (await intake(caseRequest('DISPUTE'))).caseId!;
    const agent = identity.ops('cs_agent');
    expect((await patch(agent, id, { status: 'RESOLVED' }, '"1"')).statusCode).toBe(422);
    const ok = await patch(agent, id, { status: 'RESOLVED', resultNote: '결과 통지' }, '"1"');
    expect([ok.statusCode, ok.headers.etag]).toEqual([200, '"2"']);
    const again = await patch(agent, id, { resultNote: '다시' }, '"2"');
    expect(again.statusCode).toBe(409);
    const row = (await q<Record<string, unknown>>('select status, version::text as version, result_note, resolved_at from cs_case where id = $1', [id]))[0]!;
    expect({ ...row, resolved_at: iso(row.resolved_at) }).toEqual({ status: 'RESOLVED', version: '2', result_note: '결과 통지', resolved_at: new Date(clock.now()).toISOString() });
  });

  test('R-T49 ⑥ 커서로 끝까지 읽으면 next_due_at·ID 차례이고 infinity 건이 끝에 오며 빠지거나 겹친 건이 0이다', async () => {
    const dues = [BD10, null, BD1, BD3, null, BD1];
    const made: Array<{ id: string; due: string | null }> = [];
    for (const due of dues) {
      const c = await kit.store.open({ caseId: randomUUID(), kind: 'STATEMENT_DISPUTE', targetRef: `cursor-${randomUUID()}`, nowMs: clock.now(), resultDueAtMs: due === null ? null : Date.parse(due) });
      made.push({ id: c.caseId, due });
    }
    const want = [...made].sort((x, y) => ((x.due ?? '~') === (y.due ?? '~') ? (x.id < y.id ? -1 : 1) : (x.due ?? '~') < (y.due ?? '~') ? -1 : 1)).map((m) => m.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await list(identity.ops('cs_lead'), `kind=STATEMENT_DISPUTE&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...page.items.map((x) => x.caseId!));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(want);
    expect(seen.slice(-2).sort()).toEqual(made.filter((m) => m.due === null).map((m) => m.id).sort());
    // dueWithinDays 1: 1영업일(월 23:30 KST) 안의 두 건만
    expect((await list(identity.ops('cs_lead'), 'kind=STATEMENT_DISPUTE&dueWithinDays=1')).items.map((x) => x.caseId).sort()).toEqual(made.filter((m) => m.due === BD1).map((m) => m.id).sort());
  });
});

describe('실제 DB 위 기한 경보 [R-T50 ②③]', () => {
  const alertsOf = (caseId: string) =>
    q<{ kind: string; severity: string; due: string; resolved: boolean }>("select kind, severity, detail->>'dueAt' as due, resolved_at is not null as resolved from ops_alert where detail->>'caseId' = $1 order by created_at, kind", [caseId]);

  test('R-T50 ② 경계 네 시각에 두 번씩 돌리면 DUE_SOON·OVERDUE가 한 행씩이고, R-T50 ③ 해결하면 풀리고 표시가 지워진다', async () => {
    const tick = svc.app.get(CsCaseDeadlineTick);
    const id = (await intake(caseRequest('REFUND_ACCOUNT_PENDING', { category: 'REFUND' }))).caseId!;
    const soon = Date.parse('2026-11-24T14:30:00.000Z'); // BD3에서 1영업일 전(수 공휴일을 건넘)
    const due = Date.parse(BD3);
    for (const [t, want] of [
      [soon - 1, []],
      [soon, [['CS_CASE_DUE_SOON', 'SEV3']]],
      [due - 1, [['CS_CASE_DUE_SOON', 'SEV3']]],
      [due, [['CS_CASE_DUE_SOON', 'SEV3'], ['CS_CASE_OVERDUE', 'SEV2']]],
    ] as const) {
      await tick.run(t);
      await tick.run(t);
      expect((await alertsOf(id)).map((a) => [a.kind, a.severity]), new Date(t).toISOString()).toEqual(want);
    }
    expect((await alertsOf(id)).map((a) => a.due)).toEqual([BD3, BD3]);
    const marks = (await q<Record<string, unknown>>('select due_soon_alerted_for, overdue_alerted_for from cs_case where id = $1', [id]))[0]!;
    expect([iso(marks.due_soon_alerted_for), iso(marks.overdue_alerted_for)]).toEqual([BD3, BD3]);

    expect((await patch(identity.ops('cs_agent'), id, { status: 'RESOLVED', resultNote: '계좌 입력 확인' }, '"1"')).statusCode).toBe(200);
    expect((await alertsOf(id)).map((a) => a.resolved)).toEqual([true, true]);
    await tick.run(due + 86_400_000);
    expect(await alertsOf(id)).toHaveLength(2);
    expect(await q('select due_soon_alerted_for, overdue_alerted_for from cs_case where id = $1', [id])).toEqual([{ due_soon_alerted_for: null, overdue_alerted_for: null }]);
  });

  test('R-T50 ② 배경 조립(기한 알림 작업)이 실제로 돌아 열리자마자 임박인 건(판정 대기 1영업일)의 DUE_SOON 경보를 남긴다', async () => {
    const id = (await intake(caseRequest('JUDGEMENT_PENDING', { category: 'EVENT_CANCELLATION' }))).caseId!;
    await expect.poll(async () => (await alertsOf(id)).map((a) => [a.kind, a.due]), { timeout: 10_000, interval: 100 }).toEqual([['CS_CASE_DUE_SOON', BD1]]);
  });
});

describe('정의자 함수 ops_open_cs_case 새 서명 [R-T50 ⑤ R-T48 ②]', () => {
  const TENANT = '0194f062-0000-7000-8000-0000000d0001';
  const insertRequest = async (requestId: string) =>
    q(
      `insert into event_cancellation_request (request_id, event_id, kind, status, reason, requested_by, requested_at, updated_at, requested_via, promoter_id, fault_opinion, evidence_ref)
       values ($1, $2, 'CANCEL', 'REQUESTED', '공연 취소', $3, now(), now(), 'PARTNER', $4, 'ORGANIZER', '대관 취소 통지')`,
      [requestId, randomUUID(), randomUUID(), TENANT],
    );
  async function asPartner<T>(fn: () => Promise<T>): Promise<T> {
    await admin.query('begin');
    try {
      await admin.query('set local role ops_partner');
      await admin.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
      return await fn();
    } finally {
      await admin.query('rollback');
    }
  }

  test('R-T50 ⑤ 넷째 인자(판정 기한)를 주면 판정 대기 건의 result_due_at이 되고 eventKey judgement-pending:<요청 ID>가 한 번 적힌다(두 번 불러도 한 건)', async () => {
    const requestId = randomUUID();
    await insertRequest(requestId);
    const dueIso = '2026-11-23T14:30:00.000Z';
    const got = await asPartner(async () => {
      await admin.query('select ops_open_cs_case($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)', [randomUUID(), requestId, BASE_ISO, dueIso]);
      await admin.query('select ops_open_cs_case($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)', [randomUUID(), requestId, BASE_ISO, dueIso]);
      await admin.query('reset role');
      return {
        cases: (await admin.query<Record<string, unknown>>("select id, category, result_due_at, next_due_at from cs_case where kind = 'JUDGEMENT_PENDING' and target_ref = $1", [requestId])).rows,
        requests: (await admin.query<{ event_key: string; case_id: string }>('select event_key, case_id from cs_case_request where event_key = $1', [`judgement-pending:${requestId}`])).rows,
      };
    });
    expect(got.cases.map((c) => [c.category, iso(c.result_due_at), iso(c.next_due_at)])).toEqual([['EVENT_CANCELLATION', dueIso, dueIso]]);
    expect(got.requests).toEqual([{ event_key: `judgement-pending:${requestId}`, case_id: got.cases[0]!.id }]);
  });

  test('R-T50 ⑤ 세 인자 호출도 되고(기한 없음, infinity) 이름이 같은 함수는 하나뿐이며 ops_partner만 부른다', async () => {
    const requestId = randomUUID();
    await insertRequest(requestId);
    const nextDue = await asPartner(async () => {
      await admin.query('select ops_open_cs_case($1::uuid, $2::uuid, now())', [randomUUID(), requestId]);
      await admin.query('reset role');
      return (await admin.query<{ v: string }>("select next_due_at::text as v from cs_case where kind = 'JUDGEMENT_PENDING' and target_ref = $1", [requestId])).rows.map((r) => r.v);
    });
    expect(nextDue).toEqual(['infinity']);
    const sigs = (await q<{ sig: string }>("select p.oid::regprocedure::text as sig from pg_proc p where proname = 'ops_open_cs_case'")).map((r) => r.sig);
    expect(sigs).toEqual(['ops_open_cs_case(uuid,uuid,timestamp with time zone,timestamp with time zone)']);
    expect((await q<{ ok: boolean }>("select has_function_privilege('ops_partner', $1, 'EXECUTE') as ok", [sigs[0]]))[0]!.ok).toBe(true);
  });
});

describe('화면 ↔ 실제 DB 위 ops-svc [R-T51 ①~④]', () => {
  test('R-T51 ①②③④ 화면의 생성 클라이언트로 목록·상세·If-Match 갱신을 하고, 먼저 고친 건 412와 숨긴 지급 건 404가 화면 글로 바뀐다', async () => {
    let session = identity.ops('cs_agent');
    const api = await screenApi(svc, () => session);
    const body = caseRequest('SCANNER_UNREPORTED', { category: 'QUEUE_NOT_FLUSHED' });
    const id = (await intake(body)).caseId!;
    const page = casePageOf((await api.listOpsCases({ kind: 'SCANNER_UNREPORTED', limit: 50 })).data);
    expect(page.items.map((c) => [c.caseId, c.targetRef, c.progressDueAt, c.resultDueAt, c.status])).toEqual([[id, body.sourceId, BD1, BD3, 'OPEN']]);

    const d = await api.getOpsCase(id);
    const v1 = versionOfEtag(d.headers.get('etag'))!;
    expect([caseViewOf(d.data)?.status, v1]).toEqual(['OPEN', 1]);
    const mine = await api.updateOpsCase(id, { assignee: session['x-user-id'] }, { headers: { 'If-Match': ifMatchOf(v1) } });
    expect([mine.status, versionOfEtag(mine.headers.get('etag'))]).toEqual([200, 2]);
    expect(errorOf(await caught(api.updateOpsCase(id, { status: 'IN_PROGRESS' }, { headers: { 'If-Match': ifMatchOf(v1) } })))).toMatchObject({ kind: 'stale' });

    const payout = await kit.store.open({ caseId: randomUUID(), kind: 'PAYOUT_FAILED', targetRef: `payout-${randomUUID()}`, nowMs: clock.now() });
    expect(errorOf(await caught(api.getOpsCase(payout.caseId)))).toMatchObject({ kind: 'not-found', text: '없는 건입니다' });
    session = identity.ops('viewer');
    expect(errorOf(await caught(api.listOpsCases({ limit: 50 })))).toMatchObject({ kind: 'forbidden' });
  });
});
