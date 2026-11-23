// F-03-3 경보 목록 REST GET /v1/ops/alerts와 경보 본문 칸(0029 트리거)의 실제 ops-svc + PostgreSQL 18 통합 시험(시험 먼저, ADR-0372).
// 정본: ADR-0100 결정 2(reset이면 화면은 명령·경보·승인 대기를 REST로 다시 읽는다), docs/frontend.md §3.10(걸린 경보와 풀린 지 60분 [가정] 안의 경보, 500건 [가정]),
// FE-T28 ②(경보 몫은 경보 목록 REST와 함께 F-03-3에서 판정), docs/api/asyncapi.yaml OpsAlert(journey·foldedUnder·runbookUrl·dashboardUrl·exploreUrl·dependency),
// docs/features/control-tower.md §8(예산 SEV1 아래 같은 회차·여정의 SEV2는 접힌 줄), 계획 docs/review/plans/F-03-3.md §4 'GET /v1/ops/alerts'·1-15·'감독에게' 3 (라)·10.
// 경보는 경보 받는 길(F-01-7) 대신 alerts 모듈 공개 면(RecordOpsAlert·DrizzleOpsAlertStore)으로 넣는다. 알림 표 행은 0028·0029 트리거가 쓴다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createDatabase, createService, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleOpsAlertStore, RecordOpsAlert } from '../src/modules/alerts/index.js';
import { alertListContract } from '../test/ops-alert-list-contract.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { adminAccountsForCommands } from './reauth.js';
import { Sse } from './sse.js';

const MIN = 60_000;
/** 정본 값(frontend §3.10) */
const CANON = { resolvedKeepMs: 60 * MIN, max: 500 };

const identity = new FakeIdentity();
let pgc: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
let port = 0;
let record: RecordOpsAlert;

beforeAll(async () => {
  pgc = await startPostgres();
  await migrateOps(pgc.url);
  db = createDatabase({ url: pgc.url, applicationName: 'ops-svc-alerts-it' });
  admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  vi.stubEnv('PEAKET_QUEUE_REDIS_URL', '');
  vi.stubEnv('PEAKET_PROMETHEUS_URL', '');
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, adminAccounts: adminAccountsForCommands, background: false }),
    env: { PEAKET_ENV: 'ci' },
    logDestination: quiet(),
    adminAuthz: identity,
  });
  await svc.http.listen({ host: '127.0.0.1', port: 0 });
  port = (svc.http.server.address() as AddressInfo).port;
  record = new RecordOpsAlert(new DrizzleOpsAlertStore(db), () => Date.now());
}, 240_000);

afterAll(async () => {
  const bounded = (p: Promise<unknown> | undefined) => Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(r, 15_000).unref())]);
  try {
    await Promise.allSettled([bounded(svc?.close())]);
    await Promise.allSettled([bounded(admin?.end()), bounded(db?.close())]);
  } finally {
    vi.unstubAllEnvs();
    pgc?.stop();
  }
}, 120_000);

type Alert = Record<string, unknown> & { alertId: string };
const list = async (headers: Record<string, string> = identity.ops('viewer'), query = '') => {
  const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/alerts${query}`, headers });
  return { status: r.statusCode, headers: r.headers, body: r.statusCode === 200 ? (JSON.parse(r.payload) as { items: Alert[]; seq: number }) : undefined, payload: r.payload };
};
const pushSeqOf = async (alertId: string) =>
  (await admin.query<{ seq: string }>(`select seq from ops_push_event where kind = 'alert' and body->>'alertId' = $1 order by seq`, [alertId])).rows.map((r) => Number(r.seq));

describe('F-03-3 alerts 모듈 공개 읽기(PostgreSQL 저장소)', () => {
  test('F-03-3 T18 FE-T28 ②-12 걸린 경보 전부와 풀린 지 60분 안의 경보를 돌려주고, eventKey·limit을 지킨다(PostgreSQL 짝)', async () => {
    await alertListContract(new DrizzleOpsAlertStore(db), Date.now());
  });
});

describe('F-03-3 경보 목록 REST(실제 ops-svc·PostgreSQL)', () => {
  test('F-03-3 T12 C-T32 ②-1 경보 detail의 정한 칸(journey·foldedUnder·runbookUrl·dashboardUrl·exploreUrl·dependency)만 경보 본문으로 가고, 흐름 alert 본문과 목록 본문이 같은 경보에서 같다', async () => {
    const E = randomUUID();
    const viewer = identity.ops('viewer');
    const s = await Sse.open(port, '/v1/ops/live', viewer);
    await vi.waitFor(() => expect(s.openings.length).toBe(1));
    const links = { runbookUrl: 'https://runbook.ops.test/RB-07', dashboardUrl: 'https://grafana.ops.test/d/onsale?var-event=x', exploreUrl: 'https://grafana.ops.test/explore?left=x' };
    const sev1 = await record.handle({ eventKey: E, kind: 'slo', severity: 'SEV1', source: 'f033-it', reason: '결제 확정 에러 버짓 10배 소진', detail: { journey: 'payment_confirm', ...links, calls: 7, secret: 'x' } });
    const sev2 = await record.handle({ eventKey: E, kind: 'cause', severity: 'SEV2', source: 'f033-it', reason: '결제사 승인 호출 p99 2초 초과', detail: { journey: 'payment_confirm', foldedUnder: sev1.alertId, dependency: 'toss' } });
    await vi.waitFor(() => expect(s.of('alert').map((f) => (f.data as Alert).alertId)).toEqual(expect.arrayContaining([sev1.alertId, sev2.alertId])), { timeout: 10_000 });
    const streamed = new Map(s.of('alert').map((f) => [(f.data as Alert).alertId, f.data as Alert]));
    s.close();
    expect(streamed.get(sev1.alertId)).toMatchObject({ status: 'firing', severity: 'SEV1', kind: 'slo', eventId: E, journey: 'payment_confirm', ...links });
    expect(streamed.get(sev2.alertId)).toMatchObject({ status: 'firing', severity: 'SEV2', kind: 'cause', eventId: E, journey: 'payment_confirm', foldedUnder: sev1.alertId, dependency: 'toss' });
    // 정한 칸 밖의 detail은 본문으로 가지 않는다
    expect(Object.keys(streamed.get(sev1.alertId)!)).not.toEqual(expect.arrayContaining(['calls']));
    expect(Object.keys(streamed.get(sev1.alertId)!)).not.toEqual(expect.arrayContaining(['secret']));

    const l = await list(viewer);
    expect(l.status, l.payload).toBe(200);
    expect(l.headers['cache-control']).toBe('no-store');
    const listed = new Map(l.body!.items.map((a) => [a.alertId, a]));
    // 짝 확인: 같은 경보에서 같은 칸·같은 값
    expect(listed.get(sev1.alertId)).toEqual(streamed.get(sev1.alertId));
    expect(listed.get(sev2.alertId)).toEqual(streamed.get(sev2.alertId));
  });

  test('F-03-3 T18 FE-T28 ②-13 목록은 viewer·operator·commander만 받고(cs_agent·cs_lead 403), 걸린 경보는 오래돼도 들고 풀린 경보는 60분 안만 들며, eventId를 주면 다른 회차 경보가 없다', async () => {
    for (const role of ['viewer', 'operator', 'commander'] as const) expect((await list(identity.ops(role))).status).toBe(200);
    for (const role of ['cs_agent', 'cs_lead'] as const) expect((await list(identity.ops(role))).status).toBe(403);

    const E = randomUUID();
    const F = randomUUID();
    const now = Date.now();
    const old = await record.handle({ eventKey: E, kind: 'slo', severity: 'SEV2', source: 'f033-it', reason: '3시간 전부터 걸린 경보', createdAt: new Date(now - 180 * MIN).toISOString() });
    const kept = await record.handle({ eventKey: E, kind: 'cause', severity: 'SEV2', source: 'f033-it', reason: '59분 전에 풀림', createdAt: new Date(now - 90 * MIN).toISOString() });
    await record.resolve({ eventKey: E, kind: 'cause', reason: 'ok', resolvedAt: new Date(now - CANON.resolvedKeepMs + MIN).toISOString() });
    const gone = await record.handle({ eventKey: E, kind: 'flow', severity: 'SEV2', source: 'f033-it', reason: '61분 전에 풀림', createdAt: new Date(now - 120 * MIN).toISOString() });
    await record.resolve({ eventKey: E, kind: 'flow', reason: 'ok', resolvedAt: new Date(now - CANON.resolvedKeepMs - MIN).toISOString() });
    const other = await record.handle({ eventKey: F, kind: 'slo', severity: 'SEV1', source: 'f033-it', reason: '다른 회차' });

    const all = new Map((await list()).body!.items.map((a) => [a.alertId, a]));
    expect([old, kept, other].map((a) => all.has(a.alertId))).toEqual([true, true, true]);
    expect(all.has(gone.alertId)).toBe(false);
    expect(all.get(kept.alertId)).toMatchObject({ status: 'resolved', endsAt: expect.any(String) });

    const onlyE = (await list(identity.ops('viewer'), `?eventId=${E}`)).body!.items;
    expect(onlyE.map((a) => a.alertId)).toEqual(expect.arrayContaining([old.alertId, kept.alertId]));
    expect(onlyE.filter((a) => a.eventId === F)).toEqual([]);
  });

  test('F-03-3 T18 FE-T28 ②-14 응답 seq는 응답을 만든 때의 알림 표 마지막 순번이다: 그 앞 경보의 알림 행은 seq 이하이고, 뒤에 울린 경보의 알림 행은 seq보다 크다', async () => {
    const E = randomUUID();
    const before = await record.handle({ eventKey: E, kind: 'slo', severity: 'SEV3', source: 'f033-it', reason: '앞' });
    await vi.waitFor(async () => expect((await pushSeqOf(before.alertId)).length).toBe(1));
    const l = await list();
    expect(typeof l.body!.seq).toBe('number');
    const after = await record.handle({ eventKey: E, kind: 'cause', severity: 'SEV3', source: 'f033-it', reason: '뒤' });
    const [b] = await pushSeqOf(before.alertId);
    const [a] = await pushSeqOf(after.alertId);
    expect(b!).toBeLessThanOrEqual(l.body!.seq);
    expect(a!).toBeGreaterThan(l.body!.seq);
  });

  test('F-03-3 T18 FE-T28 ②-15 경보가 500건을 넘으면 걸린 경보는 모두 남기고 풀린 경보 가운데 오래된 것부터 뺀다', async () => {
    await admin.query('delete from ops_alert');
    const firing = await admin.query<{ id: string }>(
      `insert into ops_alert (id, event_key, kind, severity, source, reason, created_at)
       select gen_random_uuid(), 'f033-cap-firing-' || g, 'slo', 'SEV2', 'f033-it', '걸림 ' || g, now() - interval '3 hours' from generate_series(1, 3) g returning id`,
    );
    // 풀린 520건: g초 전에 풀림(g가 클수록 오래됨), 모두 60분 안
    const resolved = await admin.query<{ id: string; g: number }>(
      `insert into ops_alert (id, event_key, kind, severity, source, reason, created_at, resolved_at, resolved_reason)
       select gen_random_uuid(), 'f033-cap-' || g, 'slo', 'SEV3', 'f033-it', '풀림 ' || g, now() - interval '2 hours', now() - make_interval(secs => g), 'ok' from generate_series(1, 520) g
       returning id, (regexp_replace(event_key, '^f033-cap-', ''))::int as g`,
    );
    const items = (await list()).body!.items;
    expect(items).toHaveLength(CANON.max);
    const ids = new Set(items.map((a) => a.alertId));
    expect(firing.rows.filter((r) => !ids.has(r.id))).toEqual([]);
    const keep = CANON.max - firing.rows.length;
    const newest = [...resolved.rows].sort((x, y) => x.g - y.g);
    expect(newest.slice(0, keep).filter((r) => !ids.has(r.id))).toEqual([]);
    expect(newest.slice(keep).filter((r) => ids.has(r.id))).toEqual([]);
  });
});
