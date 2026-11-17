// BAT-420 웨이브 끝 리뷰 S2(시험 담당, 구현 전에 씀, 계획 §11 보충 4): ops-svc 0015의 파트너 행 보안을 실제 PostgreSQL 18과 실제 역할로 본다.
// ops_partner는 app.tenant_id = 자기 테넌트인 event_cancellation_request 행만 SELECT·INSERT하고, 감사·CS 표는 직접 읽지 못하며 정의자 함수 둘로만 남긴다.
// ops_app은 전체를 본다. 정의자 함수는 search_path를 고정하고 EXECUTE는 정한 역할만 갖는다(감독 덧붙임).
// 정본: docs/security/authz-matrix.md §5.3 'ops-svc 구현', docs/data.md event_cancellation_request·§5, ASVS v5.0.0-8.4.1. 컨테이너는 afterAll에서 지운다.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { type PostgresContainer, startPostgres } from './postgres.js';

let container: PostgresContainer | undefined;
let admin: pg.Client;
const TENANT_A = '0194d000-0000-7000-8000-00000000000a';
const TENANT_B = '0194d000-0000-7000-8000-00000000000b';

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
}, 180_000);
afterAll(async () => {
  await admin?.end().catch(() => undefined);
  container?.stop();
});

// 칸은 0011·0013과 같다(event-cancellations.int의 base 행). 파트너 행은 귀책 의견·증빙을 함께 둔다(0013 CHECK)
const insertSql = `insert into event_cancellation_request (request_id, event_id, kind, status, reason, requested_by, requested_at, updated_at, requested_via, promoter_id, fault_opinion, evidence_ref)
  values ($1, $2, 'CANCEL', 'REQUESTED', '공연 취소', $3, now(), now(), $4, $5, case when $4 = 'PARTNER' then 'ORGANIZER' end, case when $4 = 'PARTNER' then '대관 취소 통지' end)`;
const putAsAdmin = (promoterId: string | null, via: 'PARTNER' | 'COMMANDER' = promoterId ? 'PARTNER' : 'COMMANDER') =>
  admin.query(insertSql, [randomUUID(), randomUUID(), randomUUID(), via, promoterId]);
/** 한 트랜잭션 안에서 역할을 바꾸고(SET LOCAL ROLE) 테넌트를 건 뒤 fn을 돌리고 되돌린다 */
async function asRole<T>(role: 'ops_partner' | 'ops_app', tenant: string | null | '', fn: () => Promise<T>): Promise<T> {
  await admin.query('begin');
  try {
    await admin.query(`set local role ${role}`);
    if (tenant !== null) await admin.query("select set_config('app.tenant_id', $1, true)", [tenant]);
    return await fn();
  } finally {
    await admin.query('rollback');
  }
}
const count = async () => Number((await admin.query<{ n: string }>('select count(*) as n from event_cancellation_request')).rows[0]!.n);
const visiblePromoters = async () => (await admin.query<{ p: string | null }>('select promoter_id as p from event_cancellation_request')).rows.map((r) => r.p);

describe('0015 파트너 행 보안 [BAT-420 웨이브 끝 리뷰 S2]', () => {
  test('GAT-110 S2 0015가 적용되고 역할 둘과 행 보안이 켜져 있다', async () => {
    // ops-svc 실행기(scripts/migrate.mjs)는 ops_migration 표에 이름을 남긴다(drizzle 표가 아니다). 수를 고정하지 않고 0015가 한 번 적용됐는지 본다
    const names = (await admin.query<{ name: string }>('select name from ops_migration order by name')).rows.map((r) => r.name);
    expect(names.filter((n) => n.startsWith('0015_'))).toEqual(['0015_event_cancellation_partner_rls.sql']);
    expect(names.indexOf('0015_event_cancellation_partner_rls.sql')).toBeGreaterThan(names.indexOf('0014_idempotency_record.sql'));
    const roles = (await admin.query<{ rolname: string }>("select rolname from pg_roles where rolname in ('ops_partner', 'ops_app') order by rolname")).rows.map((r) => r.rolname);
    expect(roles).toEqual(['ops_app', 'ops_partner']);
    const rls = (await admin.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid = 'public.event_cancellation_request'::regclass")).rows[0];
    expect(rls?.relrowsecurity).toBe(true);
  });

  test('GAT-110 S2 [ASVS v5.0.0-8.4.1] ops_partner는 자기 테넌트 행만 보고, 값을 안 걸거나 빈 문자열이면 오류 없이 0행이며, ops_app은 전체를 본다(허용·거부)', async () => {
    await putAsAdmin(TENANT_A);
    await putAsAdmin(TENANT_B);
    await putAsAdmin(null);
    const all = await count();
    expect(await asRole('ops_partner', TENANT_A, visiblePromoters)).toEqual(expect.arrayContaining([TENANT_A]));
    expect(await asRole('ops_partner', TENANT_A, visiblePromoters)).not.toContain(TENANT_B);
    expect((await asRole('ops_partner', TENANT_A, visiblePromoters)).every((p) => p === TENANT_A)).toBe(true);
    expect(await asRole('ops_partner', null, count)).toBe(0);
    expect(await asRole('ops_partner', '', count)).toBe(0);
    expect(await asRole('ops_app', null, count)).toBe(all);
  });

  test('GAT-110 S2 [ASVS v5.0.0-8.4.1] ops_partner는 남의 promoter_id로 넣지 못하고(42501) 자기 것은 넣으며, 고치기·지우기는 거절된다', async () => {
    await expect(asRole('ops_partner', TENANT_A, () => admin.query(insertSql, [randomUUID(), randomUUID(), randomUUID(), 'PARTNER', TENANT_B]))).rejects.toMatchObject({ code: '42501' });
    await asRole('ops_partner', TENANT_A, async () => {
      await admin.query(insertSql, [randomUUID(), randomUUID(), randomUUID(), 'PARTNER', TENANT_A]);
    });
    await putAsAdmin(TENANT_A);
    await expect(asRole('ops_partner', TENANT_A, () => admin.query("update event_cancellation_request set reason = 'x' where promoter_id = $1", [TENANT_A]))).rejects.toMatchObject({ code: '42501' });
    await expect(asRole('ops_partner', TENANT_A, () => admin.query('delete from event_cancellation_request where promoter_id = $1', [TENANT_A]))).rejects.toMatchObject({ code: '42501' });
  });

  test('GAT-110 S2 같은 연결의 앞 트랜잭션에서 건 테넌트는 다음 트랜잭션에 남지 않는다(set_config 지역 값)', async () => {
    await putAsAdmin(TENANT_A);
    expect(await asRole('ops_partner', TENANT_A, count)).toBeGreaterThan(0);
    expect(await asRole('ops_partner', null, count)).toBe(0);
  });

  test('GAT-110 S2 CHECK는 PARTNER면 promoter_id가 있어야 하고 COMMANDER 행에도 promoter_id를 적을 수 있다', async () => {
    await expect(admin.query(insertSql, [randomUUID(), randomUUID(), randomUUID(), 'PARTNER', null])).rejects.toMatchObject({ code: '23514' });
    await admin.query(insertSql, [randomUUID(), randomUUID(), randomUUID(), 'COMMANDER', TENANT_A]);
    await admin.query(insertSql, [randomUUID(), randomUUID(), randomUUID(), 'COMMANDER', null]);
  });

  test('GAT-110 S2 [ASVS v5.0.0-8.4.1] ops_partner는 audit_chain·cs_case를 직접 읽지 못하고(42501) 정의자 함수 둘은 부를 수 있다', async () => {
    for (const t of ['audit_chain', 'cs_case']) {
      await expect(asRole('ops_partner', TENANT_A, () => admin.query(`select 1 from ${t} limit 1`)), t).rejects.toMatchObject({ code: '42501' });
    }
    const fns = (await admin.query<{ proname: string; sig: string }>("select proname, p.oid::regprocedure::text as sig from pg_proc p where proname in ('ops_append_audit', 'ops_open_cs_case') order by proname")).rows;
    expect(fns.map((f) => f.proname)).toEqual(['ops_append_audit', 'ops_open_cs_case']);
    for (const f of fns) {
      const can = (await admin.query<{ ok: boolean }>("select has_function_privilege('ops_partner', $1, 'EXECUTE') as ok", [f.sig])).rows[0]!.ok;
      expect(can, f.sig).toBe(true);
    }
  });

  test('GAT-110 S2 정의자 함수 둘은 SECURITY DEFINER이고 search_path를 고정하며, PUBLIC·다른 역할은 EXECUTE가 없다(누가 부를 수 있고 누구는 못 부르는지)', async () => {
    const fns = (await admin.query<{ proname: string; sig: string; prosecdef: boolean; proconfig: string[] | null }>(
      "select proname, p.oid::regprocedure::text as sig, prosecdef, proconfig from pg_proc p where proname in ('ops_append_audit', 'ops_open_cs_case') order by proname",
    )).rows;
    expect(fns).toHaveLength(2);
    await admin.query('drop role if exists rls_outsider');
    await admin.query('create role rls_outsider nologin');
    try {
      for (const f of fns) {
        expect(f.prosecdef, f.sig).toBe(true);
        expect((f.proconfig ?? []).some((c) => /^search_path=/.test(c)), f.sig).toBe(true);
        const outsider = (await admin.query<{ ok: boolean }>("select has_function_privilege('rls_outsider', $1, 'EXECUTE') as ok", [f.sig])).rows[0]!.ok;
        expect(outsider, `${f.sig} rls_outsider`).toBe(false);
        const publicAcl = (await admin.query<{ acl: string | null }>('select proacl::text as acl from pg_proc where oid = $1::regprocedure', [f.sig])).rows[0]!.acl;
        // proacl이 비면 PUBLIC EXECUTE 기본값이 살아 있다. 'PUBLIC=X' 꼴(=X/…로 시작하는 항목)도 없어야 한다
        expect(publicAcl, `${f.sig} proacl`).not.toBeNull();
        expect(publicAcl!, `${f.sig} proacl`).not.toMatch(/(^|[{,])=X/);
      }
    } finally {
      await admin.query('drop role if exists rls_outsider');
    }
  });

  test('GAT-110 S2 ops_partner는 idempotency_record를 읽고 넣을 수 있고 그 밖 표(event_cancellation_request 말고)는 쓰지 못한다', async () => {
    const priv = async (table: string, what: string) => (await admin.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', ['ops_partner', table, what])).rows[0]!.ok;
    expect(await priv('idempotency_record', 'SELECT')).toBe(true);
    expect(await priv('idempotency_record', 'INSERT')).toBe(true);
    expect(await priv('event_cancellation_request', 'SELECT')).toBe(true);
    expect(await priv('event_cancellation_request', 'INSERT')).toBe(true);
    expect(await priv('event_cancellation_request', 'UPDATE')).toBe(false);
    expect(await priv('event_cancellation_request', 'DELETE')).toBe(false);
    expect(await priv('audit_chain', 'INSERT')).toBe(false);
    expect(await priv('cs_case', 'INSERT')).toBe(false);
  });

  // 검증 2 X25(시험 담당 l3w8-420-surv-test, 2026-11-17): 정의자 함수는 행 보안을 지나치므로 함수 안에서 테넌트를 다시 본다(authz-matrix §5.3 'ops-svc 구현').
  // 함수를 자기 테넌트로만 부르던 시험이 놓친 것: 다른 테넌트가 남의 요청 ID를 넘기면 감사·CS 건을 남기지 못하고 42501이다
  test('GAT-110 S2 [ASVS v5.0.0-8.4.1] 테넌트 B가 A의 회차 취소 요청 ID로 정의자 함수 ops_append_audit·ops_open_cs_case를 부르면 42501이고 감사·CS 건이 남지 않으며, A는 같은 ID로 부를 수 있다(허용·거부)', async () => {
    const requestId = randomUUID();
    await admin.query(insertSql, [requestId, randomUUID(), randomUUID(), 'PARTNER', TENANT_A]);
    const salt = Buffer.alloc(32, 7);
    const appendAudit = () => admin.query("select ops_append_audit('EVENT_CANCELLATION_REQUESTED', $1::uuid, $2, $3, now())", [requestId, JSON.stringify({ requestId }), salt]);
    const openCase = () => admin.query('select ops_open_cs_case($1::uuid, $2::uuid, now())', [randomUUID(), requestId]);
    const auditRows = async () => Number((await admin.query<{ n: string }>('select count(*) as n from audit_chain where record_id = $1', [requestId])).rows[0]!.n);
    const caseRows = async () => Number((await admin.query<{ n: string }>("select count(*) as n from cs_case where kind = 'JUDGEMENT_PENDING' and target_ref = $1", [requestId])).rows[0]!.n);
    // 거부: 테넌트 B(남), 테넌트 값 없음
    await expect(asRole('ops_partner', TENANT_B, appendAudit)).rejects.toMatchObject({ code: '42501' });
    await expect(asRole('ops_partner', TENANT_B, openCase)).rejects.toMatchObject({ code: '42501' });
    await expect(asRole('ops_partner', null, appendAudit)).rejects.toMatchObject({ code: '42501' });
    expect(await auditRows()).toBe(0);
    expect(await caseRows()).toBe(0);
    // 허용: 테넌트 A(자기 요청)는 같은 트랜잭션 안에서 감사 한 줄·CS 건 하나를 남긴다(asRole이 되돌리므로 밖에는 남지 않는다)
    const own = await asRole('ops_partner', TENANT_A, async () => {
      await appendAudit();
      await openCase();
      await admin.query('reset role');
      return { audit: await auditRows(), cases: await caseRows() };
    });
    expect(own).toEqual({ audit: 1, cases: 1 });
  });
});
