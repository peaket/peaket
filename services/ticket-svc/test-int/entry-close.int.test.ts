// F-05-6 입장 기록 마감 저장소·배경 작업 통합 시험 — 실제 PostgreSQL 18(BUILD_ORDER GAT-180, O-T29 ①②④⑥).
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'(한 번만·업로드와 겹칠 때 회차 잠금 배타/공유·마감 뒤 도착은 받은 시각과 마감 행 기준·
// 마감 행과 미보고 건 행은 한 트랜잭션), docs/data.md entry_close·scanner_unreported_case·scanner_queue_report, 계획 docs/review/plans/F-05-6.md §4·§6.
// 1) 같은 저장소 계약(test/entry-close-store-contract.ts)을 실제 어댑터(DrizzleEntryCloseStore)에 돌린다(메모리 짝과 같은 시험).
// 2) 두 파드 흉내: DB 연결 풀이 다른 두 저장소 인스턴스·두 EntryCloseTick이 같은 회차를 동시에 판단한다(마감 행 하나·미보고 건 기기 수만큼).
// 3) 마감과 늦은 업로드 겹침: 진짜 시계로 Promise.all([tick.run(), acceptScans]) 20회.
// 4) 되돌림: 시험 트리거로 미보고 건 행 넣기를 한 번 실패시키면 마감 행도 남지 않는다(트리거가 실제로 돌았는지 시퀀스로 본다).
// 바깥 경계(core 판매 설정·core 알림·ops CS 건)는 포트를 implements한 대역이다. start() 조립과 실제 HTTP는 entry-close-start.int.test.ts가 본다.
import { createHash, randomUUID } from 'node:crypto';
import { createDatabase, type Clock, type Database, fakeClock, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleScannerShiftStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-shift-store.js';
import type { EntryCloseCoreSink, EntryCloseStore, ScannerCaseSink, ScannerEventPolicy, ScannerEventPolicyProvider } from '../src/modules/scanner/domain/ports.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';
import { entryCloseStoreContract } from '../test/entry-close-store-contract.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

type DrizzleModule = typeof import('../src/modules/scanner/adapters/db/drizzle-entry-close-store.js');
type TickModule = typeof import('../src/modules/scanner/application/entry-close.js');
const loadDrizzle = (): Promise<DrizzleModule> => import('../src/modules/scanner/adapters/db/drizzle-entry-close-store.js');
const loadTick = (): Promise<TickModule> => import('../src/modules/scanner/application/entry-close.js');

/** 정본 '역할 유효 끝은 ends_at + 2시간' */
const ROLE_END_AFTER_ENDS_MS = 7_200_000;
/** 정본 '24시간 [가정]' */
const UNREPORTED_WAIT_MS = 86_400_000;
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000f0651';
const STAFF = '0190f3a1-7c2e-7a00-8000-0000000f0652';
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f0653';

const unreportedKey = (eventId: string, deviceId: string): string => {
  const h = createHash('sha256').update(`scanner-unreported:${eventId}:${deviceId}`).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

let pg: PostgresContainer;
let database: Database;
/** 두 번째 파드 흉내용 연결 풀 */
let database2: Database;

/** 회차의 티켓 하나(발권 때 받은 회차 시작). 티켓 ID를 돌려준다 */
async function seedEvent(eventId: string, startsAtMs: number): Promise<string> {
  const ticketId = randomUUID();
  await database.pool.query(
    `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, event_starts_at, created_at)
     values ($1, $2, $2, $3, $4, $5, '동문', 'ACTIVE', 1, 'qr', 'hash', $6, now())`,
    [ticketId, randomUUID(), randomUUID(), eventId, randomUUID(), new Date(startsAtMs)],
  );
  return ticketId;
}

async function loggedIn(eventId: string, devices: number, atMs: number): Promise<string[]> {
  const shifts = new DrizzleScannerShiftStore(database);
  const ids: string[] = [];
  for (let n = 0; n < devices; n++) {
    const deviceId = randomUUID();
    await shifts.putPlacement({ eventId, deviceId, gateZone: '동문', mode: 'IN', setBy: STAFF, atMs, expectedVersion: 0 });
    await shifts.reportReadiness({ eventId, deviceId, packageSeq: 1, clockOffsetMs: 0, pendingUploads: 0, reportedBy: STAFF, atMs });
    ids.push(deviceId);
  }
  return ids;
}

const rowsOf = async (table: 'entry_close' | 'scanner_unreported_case', eventId: string): Promise<number> =>
  Number((await database.pool.query(`select count(*)::int as n from ${table} where event_id = $1`, [eventId])).rows[0].n);

class Policy implements ScannerEventPolicyProvider {
  readonly ends = new Map<string, number>();
  async get(eventId: string): Promise<ScannerEventPolicy | undefined> {
    const endsAtMs = this.ends.get(eventId);
    return endsAtMs === undefined ? undefined : { promoterId: PROMOTER, reentryAllowed: false, endsAtMs };
  }
}
class Core implements EntryCloseCoreSink {
  async notify(_eventId: string, closedAtMs: number): Promise<{ ok: true; storedAtMs: number }> {
    return { ok: true, storedAtMs: closedAtMs };
  }
}
type CaseBody = Parameters<ScannerCaseSink['open']>[0];
class Cases implements ScannerCaseSink {
  readonly bodies: CaseBody[] = [];
  async open(c: CaseBody): Promise<boolean> {
    this.bodies.push(c);
    return true;
  }
}

async function tickOf(store: EntryCloseStore, policy: Policy, cases: Cases, clock: Clock) {
  const { EntryCloseTick } = await loadTick();
  return new EntryCloseTick({ store, policy, core: new Core(), cases, clock });
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-entry-close-int', max: 8 });
  database2 = createDatabase({ url: pg.url, applicationName: 'ticket-svc-entry-close-int-2', max: 8 });
}, 180_000);

afterAll(async () => {
  await database2?.close().catch(() => {});
  await database?.close().catch(() => {});
  pg?.stop();
});

entryCloseStoreContract('PostgreSQL', async () => {
  const { DrizzleEntryCloseStore } = await loadDrizzle();
  return {
    store: new DrizzleEntryCloseStore(database),
    shifts: new DrizzleScannerShiftStore(database),
    seedEvent: async (eventId, startsAtMs) => void (await seedEvent(eventId, startsAtMs)),
  };
});

describe('두 파드의 동시 판단(O-T29 ④)', () => {
  test('O-T29 ④ 연결 풀이 다른 두 저장소·두 배경 작업이 같은 회차를 20번 동시에 판단해도 회차마다 마감 행 1·미보고 건 행 3이고, ops가 받은 서로 다른 eventKey는 3이다', async () => {
    const { DrizzleEntryCloseStore } = await loadDrizzle();
    const ends = Date.parse('2026-11-20T12:17:43.219Z');
    const clock = fakeClock({ now: ends + ROLE_END_AFTER_ENDS_MS + UNREPORTED_WAIT_MS + 1 });
    const policy = new Policy();
    const cases = new Cases();
    const podA = await tickOf(new DrizzleEntryCloseStore(database), policy, cases, clock);
    const podB = await tickOf(new DrizzleEntryCloseStore(database2), policy, cases, clock);
    for (let round = 0; round < 20; round++) {
      const eventId = randomUUID();
      await seedEvent(eventId, ends - 3 * 3_600_000);
      const devices = await loggedIn(eventId, 3, ends - 3_600_000);
      policy.ends.set(eventId, ends);
      const [a, b] = await Promise.all([podA.run(), podB.run()]);
      expect(a.closed + b.closed, `회차 ${round}`).toBe(1);
      expect(await rowsOf('entry_close', eventId), `회차 ${round}`).toBe(1);
      expect(await rowsOf('scanner_unreported_case', eventId), `회차 ${round}`).toBe(3);
      const keys = new Set(cases.bodies.filter((c) => c.sourceId.startsWith(`${eventId}/`)).map((c) => c.eventKey));
      expect(keys, `회차 ${round}`).toEqual(new Set(devices.map((d) => unreportedKey(eventId, d))));
    }
  }, 120_000);
});

describe('마감과 늦은 업로드(O-T29 ④)', () => {
  const scanOf = (eventId: string, ticketId: string, atMs: number): ScanEventInput => ({
    id: randomUUID(),
    eventId,
    ticketId,
    scannerSessionId: SESSION,
    direction: 'IN',
    method: 'QR',
    result: 'PASS',
    gateZone: '동문',
    scannedAtDevice: new Date(atMs).toISOString(),
    knownSeq: 0,
    deviceSeq: 1,
  });
  const upload = (eventId: string, ticketId: string, scannedAtMs: number) =>
    new DrizzleScannerGateStore(database).acceptScans({ eventId, deviceId: randomUUID(), sessionId: SESSION, scans: [scanOf(eventId, ticketId, scannedAtMs)], nowMs: Date.now() });
  const afterCloseFlags = async (eventId: string): Promise<number> =>
    Number((await database.pool.query(`select count(*)::int as n from gate_flag where event_id = $1 and kind = 'AFTER_CLOSE'`, [eventId])).rows[0].n);

  test('O-T29 ④ 마감 행이 생긴 뒤 올라온 기록은 저장되고 AFTER_CLOSE가 붙는다(보정 시각이 마감보다 10분 일러도 받은 시각이 기준)', async () => {
    const { DrizzleEntryCloseStore } = await loadDrizzle();
    const eventId = randomUUID();
    const ticketId = await seedEvent(eventId, Date.now() - 5 * 3_600_000);
    const ends = Date.now() - ROLE_END_AFTER_ENDS_MS - 60_000;
    const store = new DrizzleEntryCloseStore(database);
    expect((await store.close({ eventId, nowMs: Date.now(), endsAtMs: ends, clockNow: () => Date.now() })).closed).toBe(true);
    const closedAt = (await store.closedAt(eventId))!;
    const res = await upload(eventId, ticketId, closedAt - 600_000);
    expect(res.acceptedIds).toHaveLength(1);
    expect(res.flags.map((f) => f.kind)).toContain('AFTER_CLOSE');
    expect(await afterCloseFlags(eventId)).toBe(1);
  });

  test('O-T29 ④ 마감 행이 없으면 core 사본의 마감 시각보다 보정 시각이 늦어도 AFTER_CLOSE가 붙지 않는다(ticket-svc 마감 행이 먼저)', async () => {
    const eventId = randomUUID();
    const ticketId = await seedEvent(eventId, Date.now() - 5 * 3_600_000);
    const scan = scanOf(eventId, ticketId, Date.now() - 1_000);
    const res = await new DrizzleScannerGateStore(database).acceptScans({ eventId, deviceId: randomUUID(), sessionId: SESSION, entryClosesAtMs: Date.now() - 3_600_000, scans: [scan], nowMs: Date.now() });
    expect(res.acceptedIds).toEqual([scan.id]);
    expect(res.flags.map((f) => f.kind)).not.toContain('AFTER_CLOSE');
    expect(await afterCloseFlags(eventId)).toBe(0);
  });

  test('O-T29 ④ 진짜 시계로 마감 판단과 업로드를 20번 겹쳐도 기록은 늘 저장되고, AFTER_CLOSE가 없는 기록은 모두 받은 시각 ≤ 마감 시각이며 마감 행은 하나다', async () => {
    const policy = new Policy();
    const cases = new Cases();
    const { DrizzleEntryCloseStore } = await loadDrizzle();
    const tick = await tickOf(new DrizzleEntryCloseStore(database), policy, cases, systemClock);
    let afterClose = 0;
    for (let round = 0; round < 20; round++) {
      const eventId = randomUUID();
      const ticketId = await seedEvent(eventId, Date.now() - 5 * 3_600_000);
      policy.ends.set(eventId, Date.now() - ROLE_END_AFTER_ENDS_MS - 60_000);
      const scannedAt = Date.now() - 120_000;
      const [, res] = await Promise.all([tick.run(), upload(eventId, ticketId, scannedAt)]);
      expect(res.acceptedIds, `회차 ${round}`).toHaveLength(1);
      expect(await rowsOf('entry_close', eventId), `회차 ${round}`).toBe(1);
      const row = (
        await database.pool.query<{ received_at: Date; closed_at: Date }>(
          `select s.received_at, c.closed_at from scan_event s join entry_close c on c.event_id = s.event_id where s.event_id = $1`,
          [eventId],
        )
      ).rows;
      expect(row, `회차 ${round}`).toHaveLength(1);
      const flagged = await afterCloseFlags(eventId);
      afterClose += flagged;
      const ok = flagged === 1 || row[0]!.received_at.getTime() <= row[0]!.closed_at.getTime();
      expect({ round, ok, flagged, receivedAt: row[0]!.received_at.toISOString(), closedAt: row[0]!.closed_at.toISOString() }).toMatchObject({ ok: true });
    }
    // 겹침 결과는 두 갈래 가운데 무엇이든 될 수 있다. 표시 수는 기록 수를 넘지 않는다
    expect(afterClose).toBeLessThanOrEqual(20);
  }, 120_000);
});

describe('되돌림(O-T29 ⑥)', () => {
  test('O-T29 ⑥ 미보고 건 행 넣기가 한 번 실패하면 같은 트랜잭션의 마감 행도 남지 않고(트리거 1회 실행), 다음 판단에서 마감 행·건 행이 함께 생긴다', async () => {
    const { DrizzleEntryCloseStore } = await loadDrizzle();
    const ends = Date.parse('2026-11-21T12:17:43.219Z');
    const now = ends + ROLE_END_AFTER_ENDS_MS + UNREPORTED_WAIT_MS;
    const eventId = randomUUID();
    await seedEvent(eventId, ends - 3 * 3_600_000);
    await loggedIn(eventId, 2, ends - 3_600_000);
    // 시퀀스는 거래 되돌림과 상관없이 오르므로 '한 번만'과 '실제로 돌았다'를 함께 본다
    await database.pool.query(`
      create table f056_fault_target (event_id uuid primary key);
      create sequence f056_fault_seq;
      create function f056_fail_case() returns trigger language plpgsql as $$
      begin
        if new.event_id in (select event_id from f056_fault_target) and nextval('f056_fault_seq') <= 1 then
          raise exception 'f056 fault: 미보고 건 행 넣기 실패';
        end if;
        return new;
      end $$;
      create trigger f056_fail_case before insert on scanner_unreported_case for each row execute function f056_fail_case();
    `);
    await database.pool.query('insert into f056_fault_target values ($1)', [eventId]);
    const store = new DrizzleEntryCloseStore(database);
    await expect(store.close({ eventId, nowMs: now, endsAtMs: ends, clockNow: () => now })).rejects.toThrow();
    const seq = (await database.pool.query<{ last_value: string; is_called: boolean }>('select last_value, is_called from f056_fault_seq')).rows[0]!;
    expect({ lastValue: Number(seq.last_value), isCalled: seq.is_called }).toEqual({ lastValue: 1, isCalled: true });
    expect(await rowsOf('entry_close', eventId)).toBe(0);
    expect(await rowsOf('scanner_unreported_case', eventId)).toBe(0);
    expect(await store.closedAt(eventId)).toBeUndefined();
    expect(await store.close({ eventId, nowMs: now + 60_000, endsAtMs: ends, clockNow: () => now + 60_000 })).toEqual({ closed: true, reason: 'TIMEOUT', closedAtMs: now + 60_000, unreported: 2 });
    expect(await rowsOf('entry_close', eventId)).toBe(1);
    expect(await rowsOf('scanner_unreported_case', eventId)).toBe(2);
  });
});
