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
  await ensureOutboxPartitions(database, clock, { daysAhead: 30 }).catch(() => undefined);
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
async function offerDirect(ticketId: string, from: string, to: string, expiresAtMs = clock.now() + 48 * HOUR): Promise<string> {
  const offerId = randomUUID();
  const out = await transferStore.createOffer({ offerId, ticketId, fromAccountId: from, toAccountId: to, status: 'OFFERED', expiresAtMs, createdAtMs: clock.now() }, clock.now());
  expect(out.kind).toBe('CREATED');
  return offerId;
}
const ticketRow = async (id: string) => (await q<{ account_id: string; status: string; transfer_pending: boolean; version: string }>('select account_id, status, transfer_pending, version from ticket where id = $1', [id]))[0]!;
const offerRow = async (id: string) => (await q<{ status: string; withdraw_reason: string | null }>('select status, withdraw_reason from transfer_offer where id = $1', [id]))[0]!;
const outboxRows = async (eventId: string) => q<{ topic: string; msg_key: string; payload: Buffer }>('select topic, msg_key, payload from outbox where topic = $1 and msg_key = $2 order by seq', ['trade.tickets', eventId]);
const noticeRows = async (offerId?: string) => q<{ type: string; party: string; offer_id: string; account_id: string; reason: string | null; sent_at: Date | null }>('select type, party, offer_id, account_id, reason, sent_at from transfer_notice where ($1::uuid is null or offer_id = $1::uuid) order by created_at, account_id', [offerId ?? null]);

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
    for (const id of offers) {
      const notices = await noticeRows(id);
      expect(notices.filter((n) => n.type === 'TRANSFER_WITHDRAWN' && n.reason === 'EVENT_POSTPONED')).toHaveLength(2);
    }
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
  test('F-05-11 T8 ⓪ Outbox는 기본 파티션 없이 날짜 파티션만 쓴다', async () => {
    const defaults = await q<{ n: number }>("select count(*)::int as n from pg_class where relname = 'outbox_pdefault'");
    expect(defaults[0]!.n).toBe(0);
    const partitions = await q<{ relname: string }>("select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'outbox'::regclass and c.relname like 'outbox_p%'");
    expect(partitions.length).toBeGreaterThan(0);
  });

  test('F-05-11 T8 ① 요청·거절이 trade.tickets 한 행씩 남고 eventKey가 재생에도 같다', async () => {
    const w = world();
    const t = (await issue(w.a, w.event, 1))[0]!;
    const r = await transfers.createOffer({ ticketId: t, accountId: w.a, sessionId: SESSION, reauthToken: 'r', recipientRef: (await transfers.lookupRecipient({ accountId: w.a, memberCode: w.codeB })).recipientRef, idempotencyKey: randomUUID() });
    expect((await outboxRows(w.event)).map((x) => x.topic)).toEqual(['trade.tickets']);
    const first = (await outboxRows(w.event))[0]!;
    expect(String(first.payload)).toContain('TRANSFER_OFFERED');
    expect(first.msg_key).toBe(w.event);
    const firstKey = (JSON.parse(String(first.payload)) as { eventKey: string }).eventKey;
    await transfers.reject({ offerId: r.offerId, accountId: w.b });
    const rows = await outboxRows(w.event);
    expect(rows).toHaveLength(2);
    expect(String(rows[1]!.payload)).toContain('TRANSFER_REJECTED');
    await transfers.reject({ offerId: r.offerId, accountId: w.b });
    expect(await outboxRows(w.event)).toHaveLength(2);
    expect((JSON.parse(String((await outboxRows(w.event))[0]!.payload)) as { eventKey: string }).eventKey).toBe(firstKey);
    expect(firstKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(typeof (JSON.parse(String(first.payload)) as { occurredAt: unknown }).occurredAt).toBe('number');
    // 철회·만료도 실제 표에 한 행씩 남고 accountId가 보낸 사람이다.
    const t2 = (await issue(w.a, w.event, 1))[0]!;
    const o2 = await offerDirect(t2, w.a, w.b);
    await transfers.withdraw({ offerId: o2, accountId: w.a });
    const t3 = (await issue(w.a, w.event, 1))[0]!;
    await offerDirect(t3, w.a, w.b, clock.now() - 1);
    expect(await transfers.expireOffers()).toBeGreaterThanOrEqual(1);
    const all = await outboxRows(w.event);
    const payloads = all.map((x) => JSON.parse(String(x.payload)) as { type: string; accountId: string });
    expect(payloads.filter((p) => p.type === 'TRANSFER_WITHDRAWN')).toHaveLength(1);
    expect(payloads.filter((p) => p.type === 'TRANSFER_EXPIRED')).toHaveLength(1);
    for (const p of payloads.filter((x) => x.type === 'TRANSFER_WITHDRAWN' || x.type === 'TRANSFER_EXPIRED')) expect(p.accountId).toBe(w.a);
  });

  test('F-05-11 T8 ⑤ 새 요청이 기한 지난 요청을 만료시키면 EXPIRED Outbox가 남는다', async () => {
    const w = world();
    const t = (await issue(w.a, w.event, 1))[0]!;
    await offerDirect(t, w.a, w.b, clock.now() - 1);
    const found = await transfers.lookupRecipient({ accountId: w.a, memberCode: w.codeB });
    await transfers.createOffer({ ticketId: t, accountId: w.a, sessionId: SESSION, reauthToken: 'r', recipientRef: found.recipientRef, idempotencyKey: randomUUID() });
    const payloads = (await outboxRows(w.event)).map((x) => JSON.parse(String(x.payload)) as { type: string; accountId: string });
    const expired = payloads.filter((p) => p.type === 'TRANSFER_EXPIRED');
    expect(expired).toHaveLength(1);
    expect(expired[0]!.accountId).toBe(w.a);
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
    expect((await q<{ n: number }>('select count(*)::int as n from transfer_offer where ticket_id = $1', [t]))[0]!.n).toBe(0);
  });
});

describe('F-05-11 T9 알림 행(PostgreSQL)', () => {
  test('F-05-11 T9 ⓪ transfer_notice에 lease_until과 next_attempt_at이 따로 있다', async () => {
    const cols = await q<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'transfer_notice'");
    const names = cols.map((c) => c.column_name);
    expect(names).toContain('lease_until');
    expect(names).toContain('next_attempt_at');
  });

  test('F-05-11 T9 ① 양도 사건마다 두 사람 transfer_notice 행이 생기고 중복 키가 막는다', async () => {
    const w = world();
    const t = (await issue(w.a, w.event, 1))[0]!;
    const r = await transfers.createOffer({ ticketId: t, accountId: w.a, sessionId: SESSION, reauthToken: 'r', recipientRef: (await transfers.lookupRecipient({ accountId: w.a, memberCode: w.codeB })).recipientRef, idempotencyKey: randomUUID() });
    const rows = await noticeRows(r.offerId);
    expect(rows.filter((x) => x.type === 'TRANSFER_OFFERED').map((x) => x.account_id).sort()).toEqual([w.a, w.b].sort());
    await transfers.withdraw({ offerId: r.offerId, accountId: w.a });
    const withdrawn = (await noticeRows(r.offerId)).filter((x) => x.type === 'TRANSFER_WITHDRAWN');
    expect(withdrawn.map((x) => x.account_id).sort()).toEqual([w.a, w.b].sort());
    expect(withdrawn[0]!.reason).toBe('SENDER');
    // 같은 사건을 다시 적으려 해도 유일 키가 막는다(다시 보냄은 상태로 끝나 행이 늘지 않는다)
    await expect(database.pool.query('insert into transfer_notice (id, type, party, offer_id, ticket_id, event_id, account_id, reason, created_at, attempts, next_attempt_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now(), 0, now())', [randomUUID(), 'TRANSFER_OFFERED', 'RECIPIENT', r.offerId, t, w.event, w.b, null])).rejects.toMatchObject({ code: '23505' });
    expect((await noticeRows(r.offerId)).filter((x) => x.type === 'TRANSFER_OFFERED')).toHaveLength(2);
  });

  test('F-05-11 T9 ② 알림 쓰기가 실패하면 회차 취소 전체가 되돌아간다(장애 주입)', async () => {
    const w = world();
    const t = (await issue(w.a, w.event, 1))[0]!;
    const offerId = await offerDirect(t, w.a, w.b);
    await database.pool.query(`create or replace function f0511_notice_fail() returns trigger language plpgsql as $$ begin raise exception 'f0511 알림 쓰기 실패'; end $$`);
    await database.pool.query(`create trigger f0511_notice_fail before insert on transfer_notice for each row execute function f0511_notice_fail()`);
    try {
      await expect(tickets.eventCancel({ cancellationRequestId: randomUUID(), eventId: w.event, targets: [{ ticketId: t, cancellationId: randomUUID() }], nowMs: clock.now() })).rejects.toBeTruthy();
    } finally {
      await database.pool.query(`drop trigger if exists f0511_notice_fail on transfer_notice`);
    }
    expect((await offerRow(offerId)).status).toBe('OFFERED');
    expect((await ticketRow(t)).status).toBe('TRANSFER_PENDING');
    expect((await q<{ n: number }>('select count(*)::int as n from ticket_cancellation where ticket_id = $1', [t]))[0]!.n).toBe(0);
  });
});

describe('F-05-11 T10 입장 마감의 끝(PostgreSQL)', () => {
  test('F-05-11 T10 ① entry_close(+3시간)와 마감 행 없음(+50시간)을 구분해 돌려준다', async () => {
    // 한 시계를 앞으로만 옮기므로 두 경우를 한 시험에서 차례로 본다.
    const w1 = world();
    const t1 = (await issue(w1.a, w1.event, 1))[0]!;
    const o1 = await offerDirect(t1, w1.a, w1.b);
    expect((await transfers.accept({ offerId: o1, accountId: w1.b })).status).toBe('ACCEPTED');
    const w2 = world();
    const t2 = (await issue(w2.a, w2.event, 1))[0]!;
    const o2 = await offerDirect(t2, w2.a, w2.b);
    expect((await transfers.accept({ offerId: o2, accountId: w2.b })).status).toBe('ACCEPTED');
    // 대체값(+50시간)과 다른 +3시간을 넣어 저장소가 entry_close를 읽는지 가른다(TR-06).
    await database.pool.query('insert into entry_close (event_id, closed_at, reason, role_ends_at) values ($1, $2, $3, $2) on conflict (event_id) do update set closed_at = excluded.closed_at', [w1.event, new Date(STARTS + 3 * HOUR), 'ALL_REPORTED']);
    clock.advance(STARTS + 1 - clock.now());
    await expect(transfers.returnToPayer({ ticketId: t1, accountId: w1.b, sessionId: SESSION, reauthToken: 'r', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'ENTRY_STARTED' });
    await expect(transfers.returnToPayer({ ticketId: t2, accountId: w2.b, sessionId: SESSION, reauthToken: 'r', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'ENTRY_STARTED' });
    clock.advance(STARTS + 3 * HOUR - 1 - clock.now());
    await expect(transfers.returnToPayer({ ticketId: t1, accountId: w1.b, sessionId: SESSION, reauthToken: 'r', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'ENTRY_STARTED' });
    clock.advance(1);
    expect((await transfers.returnToPayer({ ticketId: t1, accountId: w1.b, sessionId: SESSION, reauthToken: 'r', idempotencyKey: randomUUID() })).status).toBe('RETURNED');
    expect((await ticketRow(t1)).account_id).toBe(w1.a);
    // 마감 행이 없는 회차는 시작 + 50시간 −1ms까지 409, 그때부터 돌려준다.
    clock.advance(STARTS + 50 * HOUR - 1 - clock.now());
    await expect(transfers.returnToPayer({ ticketId: t2, accountId: w2.b, sessionId: SESSION, reauthToken: 'r', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'ENTRY_STARTED' });
    clock.advance(1);
    expect((await transfers.returnToPayer({ ticketId: t2, accountId: w2.b, sessionId: SESSION, reauthToken: 'r', idempotencyKey: randomUUID() })).status).toBe('RETURNED');
  });
});

describe('F-05-11 T4 I-T43 �� Ż�� ������ �� Ʈ����ǡ�deadline(PostgreSQL)', () => {
  const processWithdrawal = async (i: { accountId: string; nowMs: number; deadlineAtMs?: number }) => {
    const store = transferStore as unknown as {
      processAccountWithdrawal?: (x: { accountId: string; nowMs: number; deadlineAtMs?: number }) => Promise<{ state: string; returnedTickets: number; withdrawnOffers: number; rejectedOffers: number; pendingReceivedTickets: number }>;
      pendingWithdrawalSeconds?: (nowMs: number) => Promise<number | undefined>;
    };
    expect(store.processAccountWithdrawal, 'processAccountWithdrawal�� ����').toBeDefined();
    return { store, run: await store.processAccountWithdrawal!(i) };
  };

  test('F-05-11 T4 I-T43 �� �� deadline_at_ms�� DB�� ����, �� Ʈ������� �����ϸ� ���� �ǵ�����', async () => {
    const w = world();
    const held = (await issue(w.a, w.event, 1))[0]!;
    const heldOffer = await offerDirect(held, w.a, w.b);
    expect((await transfers.accept({ offerId: heldOffer, accountId: w.b })).status).toBe('ACCEPTED');
    const bTicket = (await issue(w.b, w.event, 1))[0]!;
    const sentOffer = await offerDirect(bTicket, w.b, w.a);
    const toB = (await issue(w.a, w.event, 1))[0]!;
    const receivedOffer = await offerDirect(toB, w.a, w.b);

    await database.pool.query(`create or replace function f0511_withdrawal_fail() returns trigger language plpgsql as $$ begin raise exception 'f0511 Ż�� ����'; end $$`);
    await database.pool.query(`create trigger f0511_withdrawal_fail before insert on transfer_notice for each row execute function f0511_withdrawal_fail()`);
    try {
      await expect(transferStore.processAccountWithdrawal!({ accountId: w.b, nowMs: clock.now(), deadlineAtMs: clock.now() + 3_000 })).rejects.toBeTruthy();
    } finally {
      await database.pool.query(`drop trigger if exists f0511_withdrawal_fail on transfer_notice`);
    }
    expect((await ticketRow(held)).account_id).toBe(w.b);
    expect((await offerRow(sentOffer)).status).toBe('OFFERED');
    expect((await offerRow(receivedOffer)).status).toBe('OFFERED');

    const deadline = clock.now() + 3_000;
    const done = await processWithdrawal({ accountId: w.b, nowMs: clock.now(), deadlineAtMs: deadline });
    expect(done.run).toMatchObject({ state: 'DONE', returnedTickets: 1, withdrawnOffers: 1, rejectedOffers: 1 });
    const runs = await q<{ state: string; deadline_at: Date | string | null }>('select state, deadline_at from transfer_withdrawal_run where account_id = $1 order by created_at desc limit 1', [w.b]);
    expect(runs[0]!.state).toBe('DONE');
    expect(new Date(runs[0]!.deadline_at!).getTime()).toBe(deadline);
    expect(await done.store.pendingWithdrawalSeconds!(clock.now())).toBeUndefined();
  });

  test('F-05-11 T4 I-T43 �� �� PENDING�̸� ���̸� �����ϰ� 24�ð� �ڿ��� ���´�', async () => {
    const w = world();
    const t = (await issue(w.a, w.event, 1))[0]!;
    const offerId = await offerDirect(t, w.a, w.b);
    expect((await transfers.accept({ offerId, accountId: w.b })).status).toBe('ACCEPTED');
    await database.pool.query('insert into entry_close (event_id, closed_at, reason, role_ends_at) values ($1, $2, $3, $2) on conflict (event_id) do update set closed_at = excluded.closed_at', [w.event, new Date(STARTS + 3 * HOUR), 'ALL_REPORTED']);
    clock.advance(STARTS + 1 - clock.now());
    const p = await processWithdrawal({ accountId: w.b, nowMs: clock.now(), deadlineAtMs: clock.now() + 3_000 });
    expect(p.run.state).toBe('PENDING');
    expect(await p.store.pendingWithdrawalSeconds!(clock.now())).toBe(0);
    clock.advance(24 * HOUR);
    expect(await p.store.pendingWithdrawalSeconds!(clock.now())).toBeGreaterThanOrEqual(24 * HOUR / 1000);
  });
});
