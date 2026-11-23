// F-05-6 책임자 이상 표시 목록 거르기 — 실제 PostgreSQL 18 한 경우(BUILD_ORDER GAT-190, O-T53 ①②, 감사 C1-16).
// 정본: docs/features/offline-gate.md §7.2 '책임자 이상 표시 목록 거르기'(배치 구역과 티켓 구역이 같은 표시만, OVERRIDE_REVIEW는 넣지 않음,
// 처리 상태로는 거르지 않음, 커서 모양 그대로), 계획 docs/review/plans/F-05-6.md §4(ScannerGateStore.listFlags 인자에 gateZone).
// HTTP·배치 없음 409는 메모리 짝 쪽 test/scanner-flags-zone.test.ts가 본다. 이 파일은 실제 어댑터의 SQL 거르기와 쪽 나누기를 본다.
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import type { GateFlagView, ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-23T11:30:00.000Z');
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f0681';
const DEVICE = '0190f3a1-7c2e-7a00-8000-0000000f0682';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000f0683';

let pg: PostgresContainer;
let database: Database;
let store: DrizzleScannerGateStore;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-flags-zone-int', max: 4 });
  store = new DrizzleScannerGateStore(database);
}, 180_000);

afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

async function ticket(eventId: string, gateZone: string): Promise<string> {
  const id = randomUUID();
  await database.pool.query(
    `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, created_at)
     values ($1, $2, $2, $3, $4, $5, $6, 'ACTIVE', 1, 'qr', 'hash', now())`,
    [id, randomUUID(), randomUUID(), eventId, randomUUID(), gateZone],
  );
  return id;
}

let deviceSeq = 0;
const scanOf = (eventId: string, ticketId: string, gateZone: string, atMs: number, over: Partial<ScanEventInput> = {}): ScanEventInput => ({
  id: randomUUID(),
  eventId,
  ticketId,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result: 'PASS',
  gateZone,
  scannedAtDevice: new Date(atMs).toISOString(),
  knownSeq: 0,
  deviceSeq: ++deviceSeq,
  ...over,
});

async function flagOf(eventId: string, ticketId: string, gateZone: string, kind: 'DUPLICATE' | 'OVERRIDE_REVIEW'): Promise<string> {
  const scans =
    kind === 'DUPLICATE'
      ? [scanOf(eventId, ticketId, gateZone, NOW - 120_000), scanOf(eventId, ticketId, gateZone, NOW - 60_000)]
      : [scanOf(eventId, ticketId, gateZone, NOW - 90_000, { method: 'OVERRIDE', overrideNote: '액정 파손' })];
  const res = await store.acceptScans({ eventId, deviceId: DEVICE, sessionId: SESSION, staffAccountId: ACCOUNT, scans, nowMs: NOW - 30_000 });
  const mine = res.flags.filter((f) => f.kind === kind);
  expect(mine).toHaveLength(1);
  return mine[0]!.flagId;
}

describe('이상 표시 목록 구역 거르기(O-T53, 실제 PostgreSQL)', () => {
  test('O-T53 ①② 동문으로 고르면 동문 중복 입장 표시만(처리한 것은 상태 OK로) 나오고 서문·OVERRIDE_REVIEW는 없으며, limit 1로 쪽을 나눠도 같다', async () => {
    const eventId = randomUUID();
    const east1 = await flagOf(eventId, await ticket(eventId, '동문'), '동문', 'DUPLICATE');
    const east2 = await flagOf(eventId, await ticket(eventId, '동문'), '동문', 'DUPLICATE');
    const override = await flagOf(eventId, await ticket(eventId, '동문'), '동문', 'OVERRIDE_REVIEW');
    const west = await flagOf(eventId, await ticket(eventId, '서문'), '서문', 'DUPLICATE');
    await store.resolveFlag({ eventId, flagId: east1, status: 'OK', note: '정상 확인', resolvedBy: ACCOUNT, nowMs: NOW - 10_000 });
    const pick = (items: GateFlagView[]) => items.map((f) => `${f.flagId}/${f.gateZone}/${f.kind}/${f.status}`).sort();
    const want = [`${east1}/동문/DUPLICATE/OK`, `${east2}/동문/DUPLICATE/OPEN`].sort();
    const full = await store.listFlags({ eventId, gateZone: '동문', limit: 50 });
    expect(pick(full.items)).toEqual(want);
    expect(full.nextCursor).toBeUndefined();
    const items: GateFlagView[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const p = await store.listFlags({ eventId, gateZone: '동문', limit: 1, ...(cursor ? { cursor } : {}) });
      if (p.nextCursor !== undefined) expect(p.items, `쪽 ${page}`).toHaveLength(1);
      items.push(...p.items);
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(pick(items)).toEqual(want);
    expect(pick(items).join()).not.toContain(override);
    expect(pick((await store.listFlags({ eventId, gateZone: '서문', limit: 50 })).items)).toEqual([`${west}/서문/DUPLICATE/OPEN`]);
  });
});
