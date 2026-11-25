// F-05-11 실제 PostgreSQL 통합 시험(계획 docs/review/plans/F-05-11.md §5 T3·T4·T8·T9·T10, §7).
// 시험 담당이 구현 전에 썼다(ADR-0372·0381). 0023(outbox·transfer_notice)과 새 저장소 메서드·모듈이 아직 없다.
// 단위 짝은 test/transfer-f0511.test.ts(같은 T 번호, 메모리 저장소)다.
// - 진짜: PostgreSQL 18(0023까지), Drizzle 저장소, TicketService·Transfers·도메인 규칙, 플랫폼 Outbox 표.
//   바꿔 끼운 것은 시계·재인증 확인 포트(늘 통과)·identity 찾기 포트(짝 가짜)·core 알림 입구(가짜 HTTP)뿐이다.
// - outbox 파티션은 시험이 만든다(플랫폼 ensureOutboxPartitions, 0023은 부모 표만 만든다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createDatabase, createService, ensureOutboxPartitions, fakeClock, type Database, type FakeClock, MemoryDpopReplayStore, type AdminAuthzPort, type ScannerSessionCheck } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleDeviceKeyStore } from '../src/modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DrizzleTransferStore } from '../src/modules/ticket/adapters/db/drizzle-transfer-store.js';
import { DeviceKeys } from '../src/modules/ticket/application/device-keys.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { Transfers } from '../src/modules/ticket/application/transfers.js';
import type { MemberCodeDirectory } from '../src/modules/ticket/domain/transfer-ports.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const STARTS = Date.parse('2026-12-02T10:37:00.000Z');
const SESSION = '0193f2c0-0000-7000-8000-000000511104';
const SECRET = 'f0511-int-secret';
const CODE_B = 'QZ7-4K2M';

class FakeAdmin implements AdminAuthzPort {
  async getAdminAuthz(): Promise<{ valid: boolean; role: string }> {
    return { valid: false, role: '' };
  }
}
class FakeSessions implements ScannerSessionCheck {
  async check(): Promise<{ valid: boolean }> {
    return { valid: false };
  }
}
class TableDirectory implements MemberCodeDirectory {
  readonly codes = new Map<string, string>();
  readonly phones = new Map<string, string>();
  async resolveMemberCode(code: string): Promise<{ accountId: string; nickname: string } | undefined> {
    const accountId = this.codes.get(code);
    return accountId === undefined ? undefined : { accountId, nickname: '지민' };
  }
  async resolvePhone(digits: string): Promise<{ accountId: string; nickname: string } | undefined> {
    const accountId = this.phones.get(digits);
    return accountId === undefined ? undefined : { accountId, nickname: '지민' };
  }
  async resolveNicknames(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return new Map(ids.map((id) => [id, '지민']));
  }
}

let pg: PostgresContainer;
let database: Database;
let clock: FakeClock;
let tickets: DrizzleTicketStore;
let transferStore: DrizzleTransferStore;
let deviceKeys: DrizzleDeviceKeyStore;
let service: TicketService;
let directory: TableDirectory;
let transfers: Transfers;
let svc: Awaited<ReturnType<typeof createService>>;
const logs: string[] = [];

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-transfer-f0511-int', max: 12 });
  clock = fakeClock({ now: NOW });
  // 0023이 없는 기준 트리에서는 outbox 표가 없어 파티션을 못 만든다. 그 실패를 여기서 멈추지 않고 시험마다 드러낸다.
  await ensureOutboxPartitions(database, clock, { daysAhead: 1 }).catch(() => undefined);
  const changes = new DrizzleScannerGateStore(database);
  deviceKeys = new DrizzleDeviceKeyStore({ database, changes });
  tickets = new DrizzleTicketStore({ database, changes, deviceKeys });
  // 새 선택 인자(clock·outboxCodec)는 구현이 더한다. 기준 트리에서도 이 파일이 읽히도록 type-escape로 넘긴다.
  transferStore = new DrizzleTransferStore({ database, deviceKeys, clock } as unknown as ConstructorParameters<typeof DrizzleTransferStore>[0]);
  service = new TicketService({ store: tickets, clock });
  directory = new TableDirectory();
  transfers = new Transfers({ store: transferStore, reauth: { verify: async () => true }, recipientRefSecret: SECRET, clock, directory });
  const replay = new MemoryDpopReplayStore(clock);
  const gate = new MemoryScannerGateStore();
  const devices = new MemoryScannerDeviceStore();
  svc = await createService({
    name: 'ticket-svc-transfer-f0511-int',
    module: AppModule.register({
      scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay, gate, shift: new MemoryScannerShiftStore(gate) },
      ticket: { deviceKeys: new DeviceKeys({ store: deviceKeys, clock }), tickets: service, transfers },
    }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' },
    clock,
    logDestination: new Writable({ write: (chunk: Buffer | string, _e, cb) => { logs.push(String(chunk)); cb(); } }),
    adminAuthz: new FakeAdmin(),
    scanner: { devices, sessions: new FakeSessions(), replay },
  });
}, 180_000);

afterAll(async () => {
  await svc?.close().catch(() => {});
  await database?.close().catch(() => {});
  pg?.stop();
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await database.pool.query(sql, params)).rows as T[];
const world = () => {
  const a = randomUUID();
  const b = randomUUID();
  const event = randomUUID();
  const codeB = `QZ7-${b.slice(0, 8).toUpperCase()}`;
  directory.codes.set(codeB, b);
  return { a, b, event, codeB };
};
async function issue(payer: string, eventId: string, n = 1): Promise<string[]> {
  const r = await service.issue({ orderId: randomUUID(), eventId, payerAccountId: payer, seatIds: Array.from({ length: n }, () => randomUUID()), issueGeneration: 0, eventStartsAtMs: STARTS });
  return r.tickets.map((t) => t.ticketId);
}
async function offerDirect(ticketId: string, from: string, to: string, expiresAtMs = NOW + 48 * HOUR): Promise<string> {
  const offerId = randomUUID();
  const out = await transferStore.createOffer({ offerId, ticketId, fromAccountId: from, toAccountId: to, status: 'OFFERED', expiresAtMs, createdAtMs: clock.now() }, clock.now());
  expect(out.kind).toBe('CREATED');
  return offerId;
}
const ticketRow = async (id: string) => (await q<{ account_id: string; status: string; transfer_pending: boolean; version: string }>('select account_id, status, transfer_pending, version from ticket where id = $1', [id]))[0]!;
const offerRow = async (id: string) => (await q<{ status: string; withdraw_reason: string | null }>('select status, withdraw_reason from transfer_offer where id = $1', [id]))[0]!;
const outboxRows = async (eventKey?: string) => q<{ topic: string; msg_key: string; payload: Buffer }>('select topic, msg_key, payload from outbox where topic = $1 and ($2::text is null or payload::text like $2) order by seq', ['trade.tickets', eventKey === undefined ? null : `%${eventKey}%`]);
const noticeRows = async () => q<{ type: string; account_id: string; reason: string | null; sent_at: Date | null }>('select type, account_id, reason, sent_at from transfer_notice order by created_at, account_id');

describe('F-05-11 T3 R-T25 ③ 연기 철회(PostgreSQL)', () => {
  test('F-05-11 T3 R-T25 ③ ① 그 회차 요청만 WITHDRAWN·EVENT_POSTPONED로 바꾸고 다른 회차는 그대로다', async () => {
    const w = world();
    const ids = await issue(w.a, w.event, 2);
    const offers = [await offerDirect(ids[0]!, w.a, w.b), await offerDirect(ids[1]!, w.a, w.b)];
    const otherEvent = randomUUID();
    const other = (await issue(w.a, otherEvent, 1))[0]!;
    const otherOffer = await offerDirect(other, w.a, w.b);
    const at = clock.now() + 5 * MIN;
    const store = transferStore as unknown as { withdrawForEvent?: (i: { eventId: string; reason: 'EVENT_POSTPONED'; nowMs: number }) => Promise<{ withdrawn: readonly string[] }> };
    expect(store.withdrawForEvent, 'withdrawForEvent가 없다').toBeDefined();
    const out = await store.withdrawForEvent!({ eventId: w.event, reason: 'EVENT_POSTPONED', nowMs: at });
    expect([...out.withdrawn].sort()).toEqual([...offers].sort());
    for (const id of offers) expect(await offerRow(id)).toMatchObject({ status: 'WITHDRAWN', withdraw_reason: 'EVENT_POSTPONED' });
    expect((await ticketRow(ids[0]!)).transfer_pending).toBe(false);
    expect((await offerRow(otherOffer)).status).toBe('OFFERED');
    expect((await store.withdrawForEvent!({ eventId: w.event, reason: 'EVENT_POSTPONED', nowMs: at + 1_000 })).withdrawn).toHaveLength(0);
  });

  test('F-05-11 T3 R-T25 ③ ② 철회 뒤 CancelTickets(EVENT_POSTPONED)가 TRANSFER_PENDING이 아니라 환급으로 끝난다', async () => {
    const w = world();
    const t = (await issue(w.a, w.event, 1))[0]!;
    await offerDirect(t, w.a, w.b);
    const store = transferStore as unknown as { withdrawForEvent?: (i: { eventId: string; reason: 'EVENT_POSTPONED'; nowMs: number }) => Promise<{ withdrawn: readonly string[] }> };
    await store.withdrawForEvent?.({ eventId: w.event, reason: 'EVENT_POSTPONED', nowMs: clock.now() });
    const orderId = (await q<{ order_id: string }>('select order_id from ticket where id = $1', [t]))[0]!.order_id;
    const out = await tickets.cancel({ cancellationId: randomUUID(), orderId, requestedByAccountId: w.a, ticketIds: [t], nowMs: clock.now(), reason: 'EVENT_POSTPONED' });
    expect(out[0]?.result).toMatch(/REFUND_NOW|REFUND_AFTER_CLOSE/);
  });
});

describe('F-05-11 T8 Outbox 여섯 사건(PostgreSQL)', () => {
  test('F-05-11 T8 ① 요청·거절이 trade.tickets 한 행씩 남고 eventKey가 재생에도 같다', async () => {
    const w = world();
    const t = (await issue(w.a, w.event, 1))[0]!;
    const r = await transfers.createOffer({ ticketId: t, accountId: w.a, sessionId: SESSION, reauthToken: 'r', recipientRef: (await transfers.lookupRecipient({ accountId: w.a, memberCode: w.codeB })).recipientRef, idempotencyKey: randomUUID() });
    expect((await outboxRows()).map((x) => x.topic)).toEqual(['trade.tickets']);
    const firstPayload = String((await outboxRows())[0]!.payload);
    expect(firstPayload).toContain('TRANSFER_OFFERED');
    expect((await outboxRows())[0]!.msg_key).toBe(w.event);
    await transfers.reject({ offerId: r.offerId, accountId: w.b });
    await transfers.reject({ offerId: r.offerId, accountId: w.b });
    const rows = await outboxRows();
    expect(rows).toHaveLength(2);
    expect(String(rows[1]!.payload)).toContain('TRANSFER_REJECTED');
  });

  test('F-05-11 T8 ④ outbox 쓰기가 실패하면 상태 변경도 되돌아간다(장애 주입)', async () => {
    const w = world();
    const t = (await issue(w.a, w.event, 1))[0]!;
    await database.pool.query(`create or replace function f0511_fail() returns trigger language plpgsql as $$ begin raise exception 'f0511 장애 주입'; end $$`);
    await database.pool.query(`create trigger f0511_fail before insert on outbox for each row execute function f0511_fail()`);
    try {
      await expect(transfers.createOffer({ ticketId: t, accountId: w.a, sessionId: SESSION, reauthToken: 'r', recipientRef: (await transfers.lookupRecipient({ accountId: w.a, memberCode: w.codeB })).recipientRef, idempotencyKey: randomUUID() })).rejects.toBeTruthy();
    } finally {
      await database.pool.query(`drop trigger if exists f0511_fail on outbox`);
    }
    expect((await ticketRow(t)).transfer_pending).toBe(false);
    expect(await offerRow(randomUUID())).toBeUndefined();
  });
});

describe('F-05-11 T9 알림 행(PostgreSQL)', () => {
  test('F-05-11 T9 ① 양도 사건마다 두 사람 transfer_notice 행이 생기고 중복 키가 막는다', async () => {
    const w = world();
    const t = (await issue(w.a, w.event, 1))[0]!;
    const r = await transfers.createOffer({ ticketId: t, accountId: w.a, sessionId: SESSION, reauthToken: 'r', recipientRef: (await transfers.lookupRecipient({ accountId: w.a, memberCode: w.codeB })).recipientRef, idempotencyKey: randomUUID() });
    const rows = await noticeRows();
    expect(rows.filter((x) => x.type === 'TRANSFER_OFFERED').map((x) => x.account_id).sort()).toEqual([w.a, w.b].sort());
    await transfers.withdraw({ offerId: r.offerId, accountId: w.a });
    const withdrawn = (await noticeRows()).filter((x) => x.type === 'TRANSFER_WITHDRAWN');
    expect(withdrawn.map((x) => x.account_id).sort()).toEqual([w.a, w.b].sort());
    expect(withdrawn[0]!.reason).toBe('SENDER');
    // 같은 사건을 다시 적으려 해도 유일 키가 막는다(다시 보냄은 상태로 끝나 행이 늘지 않는다)
    expect((await noticeRows()).filter((x) => x.type === 'TRANSFER_OFFERED')).toHaveLength(2);
  });
});

describe('F-05-11 T10 입장 마감의 끝(PostgreSQL)', () => {
  test('F-05-11 T10 ① entry_close.closed_at 뒤에는 돌려주기가 되고, 그 전에는 409다', async () => {
    const w = world();
    const t = (await issue(w.a, w.event, 1))[0]!;
    const offerId = await offerDirect(t, w.a, w.b);
    expect((await transfers.accept({ offerId, accountId: w.b })).status).toBe('ACCEPTED');
    await database.pool.query('insert into entry_close (event_id, closed_at, reason, role_ends_at) values ($1, $2, $3, $2) on conflict (event_id) do update set closed_at = excluded.closed_at', [w.event, new Date(STARTS + 50 * HOUR), 'ALL_REPORTED']);
    clock.advance(STARTS + 1 - clock.now());
    await expect(transfers.returnToPayer({ ticketId: t, accountId: w.b, sessionId: SESSION, reauthToken: 'r', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'ENTRY_STARTED' });
    clock.advance(STARTS + 50 * HOUR - clock.now());
    const out = await transfers.returnToPayer({ ticketId: t, accountId: w.b, sessionId: SESSION, reauthToken: 'r', idempotencyKey: randomUUID() });
    expect(out.status).toBe('RETURNED');
    expect((await ticketRow(t)).account_id).toBe(w.a);
  });
});
