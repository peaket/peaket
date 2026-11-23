// IR-05 Drizzle 재현 시험(구현 리뷰): 거부 기록은 통과 IN 중복 판정에 끼지 않는다.
// 정본 offline-gate §7.1. 실제 PostgreSQL에 migrateTicket을 적용한 뒤 DrizzleScannerGateStore로 두 번 받는다.
import { createDatabase, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f5901';
const DEVICE = '0190f3a1-7c2e-7a00-8000-0000000f5902';
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f5903';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000f5904';
const A = '0190f3a1-7c2e-7a00-8000-0000000f5905';
const B = '0190f3a1-7c2e-7a00-8000-0000000f5906';
const C = '0190f3a1-7c2e-7a00-8000-0000000f5907';
const D = '0190f3a1-7c2e-7a00-8000-0000000f5908';

let pg: PostgresContainer;
let database: Database;
let store: DrizzleScannerGateStore;
let n = 0;

const scan = (ticketId: string, atMs: number, result: 'PASS' | 'REJECT' | 'CHECK', reason?: ScanEventInput['reason']): ScanEventInput => ({
  id: randomUUID(),
  eventId: EVENT,
  ticketId,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result,
  ...(reason !== undefined ? { reason } : {}),
  gateZone: '동문',
  scannedAtDevice: new Date(atMs).toISOString(),
  knownSeq: 0,
  deviceSeq: ++n,
});
const accept = (scans: ScanEventInput[], o: { reentryAllowed?: boolean } = {}) =>
  store.acceptScans({
    eventId: EVENT,
    deviceId: DEVICE,
    sessionId: SESSION,
    sessions: { [SESSION]: { accountId: ACCOUNT, validFromMs: T0 - 3_600_000, validUntilMs: T0 + 3_600_000 } },
    ...(o.reentryAllowed === true ? { reentryAllowed: true } : {}),
    scans,
    nowMs: T0 + 3_600_000,
  });
const rows = async (ids: string[]) =>
  (await database.pool.query('select id::text, result, reason, flag from scan_event where id = any($1::uuid[])', [ids])).rows as {
    id: string;
    result: string;
    reason: string | null;
    flag: string;
  }[];
const duplicates = async (ticketId: string) =>
  ((await database.pool.query("select count(*)::int as n from gate_flag where ticket_id = $1 and kind = 'DUPLICATE'", [ticketId])).rows[0] as { n: number }).n;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-f054-ir05', max: 4 });
  store = new DrizzleScannerGateStore(database);
  for (const ticketId of [A, B, C, D]) {
    await database.pool.query(
      `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, created_at)
       values ($1, $2, $2, $3, $4, $5, '동문', 'ACTIVE', 1, 'qr', 'hash', now())`,
      [ticketId, ACCOUNT, randomUUID(), EVENT, randomUUID()],
    );
  }
}, 120_000);

afterAll(async () => {
  await database?.close().catch(() => undefined);
  pg?.stop();
});

describe('IR-05 Drizzle: 거부 기록은 통과 IN 중복 판정에 끼지 않는다', () => {
  test('나중 PASS 뒤에 더 이른 BAD_SIGNATURE 거부가 와도 PASS·DUPLICATE가 바뀌지 않는다', async () => {
    const pass = scan(A, T0 + 10_000, 'PASS');
    await accept([pass]);
    const reject = scan(A, T0, 'REJECT', 'BAD_SIGNATURE');
    expect((await accept([reject])).flags).toEqual([]);
    expect(await rows([pass.id, reject.id])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pass.id, result: 'PASS', flag: 'NONE' }),
        expect.objectContaining({ id: reject.id, result: 'REJECT', reason: 'BAD_SIGNATURE', flag: 'NONE' }),
      ]),
    );
    expect(await duplicates(A)).toBe(0);
  });

  test('PASS 뒤에 더 늦은 QR_EXPIRED 거부가 와도 거부로 남고 DUPLICATE가 없다', async () => {
    const pass = scan(B, T0 + 10_000, 'PASS');
    await accept([pass]);
    const reject = scan(B, T0 + 20_000, 'REJECT', 'QR_EXPIRED');
    expect((await accept([reject])).flags).toEqual([]);
    expect((await rows([reject.id]))[0]).toMatchObject({ result: 'REJECT', reason: 'QR_EXPIRED', flag: 'NONE' });
    expect(await duplicates(B)).toBe(0);
  });

  test('통과 기록 둘은 지금처럼 늦은 쪽이 ALREADY_IN·DUPLICATE다', async () => {
    const first = scan(C, T0 + 10_000, 'PASS');
    await accept([first]);
    const second = scan(C, T0 + 20_000, 'PASS');
    expect((await accept([second])).flags.map((f) => f.kind)).toEqual(['DUPLICATE']);
    expect((await rows([second.id]))[0]).toMatchObject({ result: 'REJECT', reason: 'ALREADY_IN' });
    expect(await duplicates(C)).toBe(1);
  });

  test('재입장 허용 회차에서도 거부 기록은 REJECT/사유 그대로이고 NO_EXIT를 만들지 않는다', async () => {
    const pass = scan(D, T0 + 10_000, 'PASS');
    expect((await accept([pass], { reentryAllowed: true })).flags).toEqual([]);
    for (const reason of ['BAD_SIGNATURE', 'QR_EXPIRED', 'KEY_UNKNOWN'] as const) {
      const reject = scan(D, T0 + 20_000, 'REJECT', reason);
      const r = await accept([reject], { reentryAllowed: true });
      expect(r.flags, reason).toEqual([]);
      expect((await rows([reject.id]))[0], reason).toMatchObject({ result: 'REJECT', reason, flag: 'NONE' });
      expect((await rows([pass.id]))[0], reason).toMatchObject({ result: 'PASS' });
    }
    // 앱이 실제로 보내는 재입장 확인(CHECK/NO_EXIT_RECORD)은 §7.1의 NO_EXIT 이상 표시를 만든다
    const check = scan(D, T0 + 30_000, 'CHECK', 'NO_EXIT_RECORD');
    const rc = await accept([check], { reentryAllowed: true });
    expect(rc.flags.map((f) => f.kind)).toEqual(['NO_EXIT']);
    expect((await rows([check.id]))[0]).toMatchObject({ result: 'CHECK', reason: 'NO_EXIT_RECORD', flag: 'NO_EXIT' });
    const second = scan(D, T0 + 40_000, 'PASS');
    expect((await accept([second], { reentryAllowed: true })).flags.map((f) => f.kind)).toEqual(['NO_EXIT']);
    expect((await rows([second.id]))[0]).toMatchObject({ result: 'CHECK', reason: 'NO_EXIT_RECORD' });
  });
});
