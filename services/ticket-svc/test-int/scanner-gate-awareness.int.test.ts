// F-05-6 중복 입장 '몰랐음/알고도 통과'의 앞 기록 번호 — 실제 PostgreSQL 18(BUILD_ORDER GAT-180, O-T2 ①, 감사 C1-03).
// 정본: docs/features/offline-gate.md §7.1 '앞 기록 번호'(SCAN_STATE를 적을 때 그 일련번호를 scan_event.state_seq에 남기고, 갈림은 정상으로 남은
// 가장 이른 기록의 state_seq와 견준다. state_seq가 없으면 CONCURRENT. 내려간 기록은 새 정상의 state_seq로 견준다), §11 O-T2 ①
// (시차·업로드 순서를 바꾼 중복 3,000건 이상, '100%'는 시험한 건수를 모두 잡았다는 뜻), docs/data.md scan_event.state_seq.
// 메모리 짝은 test/scanner-gate-awareness.test.ts다. 이 파일은 실제 어댑터(DrizzleScannerGateStore)와 state_seq 칸을 본다.
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f0671';
const DEVICE_A = '0190f3a1-7c2e-7a00-8000-0000000f0672';
const DEVICE_B = '0190f3a1-7c2e-7a00-8000-0000000f0673';

let pg: PostgresContainer;
let database: Database;
let store: DrizzleScannerGateStore;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-awareness-int', max: 6 });
  store = new DrizzleScannerGateStore(database);
}, 180_000);

afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

/** 회차 하나에 티켓 n장을 한 번에 심는다 */
async function seed(eventId: string, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => randomUUID());
  await database.pool.query(
    `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, created_at)
     select t.id, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $2, gen_random_uuid(), '동문', 'ACTIVE', 1, 'qr', 'hash', now() from unnest($1::uuid[]) as t(id)`,
    [ids, eventId],
  );
  return ids;
}

let deviceSeq = 0;
const scanOf = (eventId: string, ticketId: string, atMs: number, knownSeq: number): ScanEventInput => ({
  id: randomUUID(),
  eventId,
  ticketId,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result: 'PASS',
  gateZone: '동문',
  scannedAtDevice: new Date(atMs).toISOString(),
  knownSeq,
  deviceSeq: ++deviceSeq,
});

const upload = (eventId: string, deviceId: string, scans: ScanEventInput[]) => store.acceptScans({ eventId, deviceId, sessionId: SESSION, scans, nowMs: T0 + 600_000 });

const stateSeqOf = async (eventId: string, scanId: string): Promise<number | null> => {
  const r = await database.pool.query<{ state_seq: string | null }>('select state_seq from scan_event where event_id = $1 and id = $2', [eventId, scanId]);
  expect(r.rows, scanId).toHaveLength(1);
  return r.rows[0]!.state_seq === null ? null : Number(r.rows[0]!.state_seq);
};

/** 다른 티켓 기록 셋으로 회차 마지막 번호를 올린다(옛 동작 '지금 마지막 번호와 견줌'과 갈리게) */
async function bump(eventId: string): Promise<void> {
  const others = await seed(eventId, 3);
  await upload(eventId, DEVICE_A, others.map((t, i) => scanOf(eventId, t, T0 + i, 0)));
}

describe('state_seq와 갈림(O-T2 ①, 실제 PostgreSQL)', () => {
  test('O-T2 ① 통과 기록의 state_seq는 그 기록의 SCAN_STATE 변경 번호이고, 나중 기록 knownSeq s−1은 CONCURRENT·s는 KNOWN이다', async () => {
    for (const [offset, awareness] of [
      [-1, 'CONCURRENT'],
      [0, 'KNOWN'],
    ] as const) {
      const eventId = randomUUID();
      const [ticketId] = (await seed(eventId, 1)) as [string];
      const first = scanOf(eventId, ticketId, T0, 0);
      await upload(eventId, DEVICE_A, [first]);
      const s = await stateSeqOf(eventId, first.id);
      const change = (await store.changes({ eventId, after: 0, limit: 1000 })).changes.filter((c) => c.kind === 'SCAN_STATE' && c.payload.ticketId === ticketId);
      expect(change.map((c) => c.seq)).toEqual([s]);
      await bump(eventId);
      expect((await store.changes({ eventId, after: 0, limit: 1000 })).lastSeq).toBeGreaterThan(s!);
      const res = await upload(eventId, DEVICE_B, [scanOf(eventId, ticketId, T0 + 60_000, s! + offset)]);
      expect(res.flags.map((f) => ({ kind: f.kind, awareness: f.awareness }))).toEqual([{ kind: 'DUPLICATE', awareness }]);
      const stored = (await database.pool.query<{ awareness: string }>(`select awareness from gate_flag where event_id = $1 and ticket_id = $2 and kind = 'DUPLICATE'`, [eventId, ticketId])).rows;
      expect(stored.map((r) => r.awareness)).toEqual([awareness]);
    }
  });

  test('O-T2 ① 정상 기록의 state_seq가 빈 옛 행이면 나중 기록은 knownSeq가 커도 CONCURRENT다', async () => {
    const eventId = randomUUID();
    const [ticketId] = (await seed(eventId, 1)) as [string];
    const first = scanOf(eventId, ticketId, T0, 0);
    await upload(eventId, DEVICE_A, [first]);
    await database.pool.query('update scan_event set state_seq = null where event_id = $1 and id = $2', [eventId, first.id]);
    const res = await upload(eventId, DEVICE_B, [scanOf(eventId, ticketId, T0 + 60_000, 1_000_000)]);
    expect(res.flags.map((f) => ({ kind: f.kind, awareness: f.awareness }))).toEqual([{ kind: 'DUPLICATE', awareness: 'CONCURRENT' }]);
  });

  /** 내림 장면 하나(메모리 짝 시험과 같은 차례): 늦은 기록(knownSeq k) → bump → 이른 기록. 회차마다 번호가 1부터라 같은 장면이면 번호가 같다 */
  async function demotion(k: number) {
    const eventId = randomUUID();
    const [ticketId] = (await seed(eventId, 1)) as [string];
    const late = scanOf(eventId, ticketId, T0 + 60_000, k);
    await upload(eventId, DEVICE_B, [late]);
    const sLate = (await stateSeqOf(eventId, late.id))!;
    await bump(eventId);
    const L = (await store.changes({ eventId, after: 0, limit: 1000 })).lastSeq;
    const early = scanOf(eventId, ticketId, T0, 0);
    const res = await upload(eventId, DEVICE_A, [early]);
    const sEarly = (await stateSeqOf(eventId, early.id))!;
    return { eventId, ticketId, late, early, res, sLate, L, sEarly };
  }

  test('O-T2 ① 늦은 기록을 먼저 올린 뒤 이른 기록이 오면 정상이 바뀌고, 내려간 기록은 새 정상의 state_seq로 견준다: s_late ≤ knownSeq < s_early면 CONCURRENT, = s_early면 KNOWN(시험 리뷰 RV-02)', async () => {
    const probe = await demotion(0);
    expect(probe.L).toBeGreaterThan(probe.sLate);
    expect(probe.sEarly).toBeGreaterThan(probe.L);
    const gap = probe.sEarly - probe.L;
    for (const [k, awareness] of [
      [probe.L + gap - 1, 'CONCURRENT'],
      [probe.L + gap, 'KNOWN'],
    ] as const) {
      const d = await demotion(k);
      expect({ L: d.L, sEarly: d.sEarly, sLate: d.sLate }, `k=${k}`).toEqual({ L: probe.L, sEarly: probe.sEarly, sLate: probe.sLate });
      expect(k, `k=${k}`).toBeGreaterThanOrEqual(d.sLate);
      expect(d.res.flags.map((f) => ({ kind: f.kind, awareness: f.awareness })), `k=${k}`).toEqual([{ kind: 'DUPLICATE', awareness }]);
      const rows = (await database.pool.query<{ id: string; result: string; flag: string }>('select id, result, flag from scan_event where event_id = $1 and ticket_id = $2', [d.eventId, d.ticketId])).rows;
      expect(Object.fromEntries(rows.map((r) => [r.id, `${r.result}/${r.flag}`])), `k=${k}`).toEqual({ [d.early.id]: 'PASS/NONE', [d.late.id]: 'REJECT/DUPLICATE' });
    }
  });

  test('O-T2 ① 시차 1~120초·올리는 차례를 바꾼 중복 3,000건은 표시 3,000개(모두 CONCURRENT)이고 정상은 모두 보정 시각이 가장 이른 기록이다', async () => {
    const eventId = randomUUID();
    const N = 3_000;
    const tickets = await seed(eventId, N);
    const early: ScanEventInput[] = [];
    const late: ScanEventInput[] = [];
    tickets.forEach((t, i) => {
      // 시차는 1~120초를 고르게 돈다(난수 없이 차례로)
      const gapMs = (1 + ((i * 37) % 120)) * 1_000;
      early.push(scanOf(eventId, t, T0 + i, 0));
      late.push(scanOf(eventId, t, T0 + i + gapMs, 0));
    });
    // 짝수 티켓은 이른 기록을 먼저, 홀수 티켓은 늦은 기록을 먼저 올린다(두 기기가 각자 묶음으로 올림)
    const firstA = tickets.map((_, i) => (i % 2 === 0 ? early[i]! : late[i]!));
    const secondB = tickets.map((_, i) => (i % 2 === 0 ? late[i]! : early[i]!));
    for (let i = 0; i < N; i += 500) await upload(eventId, DEVICE_A, firstA.slice(i, i + 500));
    for (let i = 0; i < N; i += 500) await upload(eventId, DEVICE_B, secondB.slice(i, i + 500));
    const flags = (await database.pool.query<{ ticket_id: string; awareness: string; n: number }>(
      `select ticket_id, awareness, count(*)::int as n from gate_flag where event_id = $1 and kind = 'DUPLICATE' group by ticket_id, awareness`,
      [eventId],
    )).rows;
    expect(flags).toHaveLength(N);
    expect(flags.every((f) => f.n === 1 && f.awareness === 'CONCURRENT')).toBe(true);
    const pass = (await database.pool.query<{ id: string }>(`select id from scan_event where event_id = $1 and result = 'PASS'`, [eventId])).rows.map((r) => r.id);
    expect(pass).toHaveLength(N);
    expect(new Set(pass)).toEqual(new Set(early.map((s) => s.id)));
  }, 240_000);
});
