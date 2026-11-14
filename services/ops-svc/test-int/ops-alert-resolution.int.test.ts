// ops-svc ops_alert 해제·재개 실제 PostgreSQL 18 통합 시험(BAT-450 O-T20, R-586, 마이그레이션 0007).
import { createDatabase, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { DrizzleOpsAlertStore } from '../src/modules/alerts/adapters/db/drizzle-ops-alert-store.js';
import { RecordOpsAlert } from '../src/modules/alerts/application/record-alert.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000002';
const KIND = `scanner-freshness:${DEVICE}`;

let pg: PostgresContainer;
let database: Database;
let record: RecordOpsAlert;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateOps(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ops-svc-alert-resolution-test', max: 4 });
  record = new RecordOpsAlert(new DrizzleOpsAlertStore(database), () => NOW);
});

afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

describe('ops_alert 해제·재개 PostgreSQL [BAT-450]', () => {
  test('0007이 resolved_at·resolved_reason을 더한다', async () => {
    const cols = (await database.pool.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ops_alert'")).rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['resolved_at', 'resolved_reason']));
  });

  test('열린 경보는 첫 값을 지키고, 풀면 해제 시각을 남기며, 다시 나빠지면 같은 행을 다시 연다', async () => {
    const first = await record.handle({ eventKey: EVENT, kind: KIND, severity: 'SEV2', source: 'ticket-svc', reason: 'stale', detail: { ageMs: 120_001 }, createdAt: new Date(NOW).toISOString() });
    const openAgain = await record.handle({ eventKey: EVENT, kind: KIND, severity: 'SEV2', source: 'ticket-svc', reason: 'stale', detail: { ageMs: 150_000 }, createdAt: new Date(NOW + 1_000).toISOString() });
    expect(openAgain.alertId).toBe(first.alertId);
    expect(openAgain.detail).toEqual({ ageMs: 120_001 });

    const resolved = await record.resolve({ eventKey: EVENT, kind: KIND, reason: 'fresh', resolvedAt: new Date(NOW + 2_000).toISOString() });
    expect(resolved).toMatchObject({ alertId: first.alertId, resolvedAtMs: NOW + 2_000, resolvedReason: 'fresh' });

    const reopened = await record.handle({ eventKey: EVENT, kind: KIND, severity: 'SEV2', source: 'ticket-svc', reason: 'stale again', detail: { ageMs: 130_000 }, createdAt: new Date(NOW + 3_000).toISOString() });
    expect(reopened.alertId).toBe(first.alertId);
    expect(reopened.resolvedAtMs).toBeUndefined();
    expect(reopened.detail).toEqual({ ageMs: 130_000 });

    const row = (await database.pool.query('select count(*)::int as n from ops_alert where event_key = $1 and kind = $2', [EVENT, KIND])).rows[0] as { n: number };
    expect(row.n).toBe(1);
    expect(await record.resolve({ eventKey: '0190f3a1-7c2e-7a00-8000-000000000099', kind: 'nope', reason: 'r' })).toBeUndefined();
  });
});
