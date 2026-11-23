// F-05-2 양도 앞 몫 실제 PostgreSQL 통합 시험(BUILD_ORDER GAT-050·GAT-055, 계획 docs/review/plans/F-05-2.md §5 T1~T8).
// 시험 담당(lane2-f052-test)이 구현 전에 썼다(ADR-0372·0381). 단위 짝은 test/transfer-f052.test.ts(같은 T 번호, 메모리 저장소)다.
// 정본: docs/features/transfer-refund.md §3.1('모든 판정은 티켓 행 잠금 안에서')·§5('진행 중인 양도 요청')·§7.4 ①(FRAUD_LOCK)·§11 R-T25,
//       docs/data.md transfer_offer·ticket_operator_cancellation, docs/api/openapi.yaml getTicket·listTransfers·createTransferRecipientLookup, docs/api/guidelines.md §4.
// - 진짜: PostgreSQL 18(0018까지 마이그레이션), Drizzle 저장소 셋, 처리기·Transfers·TicketService·도메인 규칙. 바꿔 끼운 것은 시계(fakeClock),
//   재인증 확인 포트(늘 통과, 실제 확인기는 transfer-wiring.int.test.ts), identity 회원 코드 찾기 포트(짝 가짜)뿐이다.
// - 장애 주입은 DB 트리거로 그 쓰기만 실패시킨다(트리거는 시험이 만들고 지운다).
// - 0018 표 이름(transfer_recipient_lookup)은 계획 §4 '0018 표(제안 이름)'를 쓴다. 다르면 '시험 이의'로 맞춘다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createDatabase, createService, fakeClock, type Database, type FakeClock, MemoryDpopReplayStore, type AdminAuthzPort, type ScannerSessionCheck } from '@peaket/platform';
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
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
/** 공연 시작 19:37 KST(어긋난 분) */
const STARTS = Date.parse('2026-12-02T10:37:00.000Z');
const CLOSE = STARTS - 2 * HOUR;
const SESSION = '0193f2c0-0000-7000-8000-00000052d104';
const SECRET = 'f052-int-secret';
const CODE_B = 'QZ7-4K2M';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** identity 회원 코드 찾기 포트 짝 가짜: 코드 → 계정 표를 시험이 채우고, 부른 코드를 적는다 */
class TableDirectory implements MemberCodeDirectory {
  readonly codes = new Map<string, string>();
  readonly calls: string[] = [];
  /** 참이면 gRPC 클라이언트처럼 던진다(GrpcMemberCodeDirectory와 같은 실패 모양, RV-10) */
  fail = false;
  async resolveMemberCode(code: string): Promise<{ accountId: string; nickname: string } | undefined> {
    this.calls.push(code);
    if (this.fail) throw new Error('14 UNAVAILABLE: identity-svc 연결 실패');
    const accountId = this.codes.get(code);
    return accountId === undefined ? undefined : { accountId, nickname: '회원' };
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
let svc: Awaited<ReturnType<typeof createService>>;
const logs: string[] = [];

interface Res {
  readonly status: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly raw: string;
  readonly body: Record<string, unknown>;
}

async function send(method: 'GET' | 'POST', url: string, account: string, o: { body?: unknown; key?: string; reauth?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-user-id': account, 'x-session-id': SESSION, 'x-user-aud': 'fan' };
  if (method === 'POST') headers['idempotency-key'] = o.key ?? randomUUID();
  if (o.reauth !== undefined) headers['x-reauth-token'] = o.reauth;
  const r = await svc.http.inject({ method, url, headers, ...(method === 'POST' ? { payload: JSON.stringify(o.body ?? {}) } : {}) });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(r.payload) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: r.statusCode, headers: r.headers, raw: r.payload, body };
}
const get = (url: string, account: string) => send('GET', url, account);
const post = (url: string, account: string, o: { body?: unknown; key?: string; reauth?: string } = {}) => send('POST', url, account, o);

/** 시험마다 새 계정·회차(공유 DB의 이름공간, TA-V09). 받는 사람 B의 회원 코드는 계정마다 다르다 */
function world() {
  const a = randomUUID();
  const b = randomUUID();
  const event = randomUUID();
  // 회원 코드는 대문자로 맞춰 찾는다(normalizeMemberCode). 시험 코드도 대문자로 만든다
  const codeB = `QZ7-${b.slice(0, 8).toUpperCase()}`;
  directory.codes.set(codeB, b);
  return { a, b, event, codeB };
}

async function issue(payer: string, eventId: string, seats = 1, startsAtMs = STARTS): Promise<string[]> {
  const r = await service.issue({ orderId: randomUUID(), eventId, payerAccountId: payer, seatIds: Array.from({ length: seats }, () => randomUUID()), issueGeneration: 0, eventStartsAtMs: startsAtMs });
  return r.tickets.map((t) => t.ticketId);
}

/** 결제자 → 받는 사람 양도 요청(실제 HTTP 길). offerId */
async function offer(ticketId: string, from: string, code: string): Promise<string> {
  const found = await post('/v1/transfer-recipient-lookups', from, { body: { memberCode: code } });
  expect(found.status, found.raw).toBe(200);
  const created = await post(`/v1/tickets/${ticketId}/transfers`, from, { body: { recipientRef: found.body.recipientRef }, reauth: 'r' });
  expect(created.status, created.raw).toBe(201);
  return String(created.body.offerId);
}

/** 저장소 길로 바로 양도 요청(경합 시험의 준비, 조회 한도를 쓰지 않으려고) */
async function offerDirect(ticketId: string, from: string, to: string): Promise<string> {
  const offerId = randomUUID();
  const out = await transferStore.createOffer({ offerId, ticketId, fromAccountId: from, toAccountId: to, status: 'OFFERED', expiresAtMs: clock.now() + 48 * HOUR, createdAtMs: clock.now() }, clock.now());
  expect(out.kind).toBe('CREATED');
  return offerId;
}

let keySeq = 0;
async function registerKey(ticketId: string, accountId: string, reason: 'ISSUE' | 'TRANSFER' = 'ISSUE'): Promise<void> {
  keySeq += 1;
  const keyId = new Uint8Array(8);
  new DataView(keyId.buffer).setUint32(4, keySeq);
  const out = await deviceKeys.register({ ticketId, accountId, keyId, publicKey: new Uint8Array(33).fill(2), reason, nowMs: clock.now(), reauthVerified: false });
  expect(out.kind).toBe('REGISTERED');
}

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await database.pool.query(sql, params)).rows as T[];
const ticketRow = async (id: string) => (await q<{ account_id: string; status: string; transfer_pending: boolean; version: string; key_revoked_at: Date | null }>('select account_id, status, transfer_pending, version, key_revoked_at from ticket where id = $1', [id]))[0]!;
const offerRow = async (id: string) => (await q<{ status: string; withdraw_reason: string | null; decided_at: Date | null }>('select status, withdraw_reason, decided_at from transfer_offer where id = $1', [id]))[0]!;
const activeKeys = async (ticketId: string) => (await q<{ n: number }>('select count(*)::int as n from device_key where ticket_id = $1 and revoked_at is null', [ticketId]))[0]!.n;
const revokedKeys = async (ticketId: string) => (await q<{ n: number }>('select count(*)::int as n from device_key where ticket_id = $1 and revoked_at is not null', [ticketId]))[0]!.n;

/** 그 트리거를 걸고 fn을 부른 뒤 늘 지운다(장애 주입). 대상 UUID는 형식을 확인한 값만 DDL에 넣는다 */
async function withFailingTrigger<T>(o: { table: string; when: string; ids?: readonly string[] }, fn: () => Promise<T>): Promise<T> {
  for (const id of o.ids ?? []) if (!UUID.test(id)) throw new Error(`UUID가 아니다: ${id}`);
  await database.pool.query(`create or replace function f052_fail() returns trigger language plpgsql as $$ begin raise exception 'f052 장애 주입: % 쓰기 실패', tg_table_name; end $$`);
  await database.pool.query(`create trigger f052_fail before insert or update on ${o.table} for each row when (${o.when}) execute function f052_fail()`);
  try {
    return await fn();
  } finally {
    await database.pool.query(`drop trigger if exists f052_fail on ${o.table}`);
  }
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-transfer-f052-int', max: 12 });
  clock = fakeClock({ now: NOW });
  const changes = new DrizzleScannerGateStore(database);
  deviceKeys = new DrizzleDeviceKeyStore({ database, changes });
  tickets = new DrizzleTicketStore({ database, changes, deviceKeys });
  transferStore = new DrizzleTransferStore({ database, deviceKeys });
  service = new TicketService({ store: tickets, clock });
  directory = new TableDirectory();
  const transfers = new Transfers({ store: transferStore, reauth: { verify: async () => true }, recipientRefSecret: SECRET, clock, directory });
  const replay = new MemoryDpopReplayStore(clock);
  const gate = new MemoryScannerGateStore();
  const devices = new MemoryScannerDeviceStore();
  svc = await createService({
    name: 'ticket-svc-transfer-f052-int',
    module: AppModule.register({
      scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay, gate, shift: new MemoryScannerShiftStore(gate) },
      ticket: { deviceKeys: new DeviceKeys({ store: deviceKeys, clock }), tickets: service, transfers },
    }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' },
    clock,
    logDestination: new Writable({
      write: (chunk: Buffer | string, _e, cb) => {
        logs.push(String(chunk));
        cb();
      },
    }),
    adminAuthz: new FakeAdmin(),
    scanner: { devices, sessions: new FakeSessions(), replay },
  });
}, 180_000);

afterAll(async () => {
  await svc?.close().catch(() => {});
  await database?.close().catch(() => {});
  pg?.stop();
});

const cancelInput = (eventId: string, ticketIds: readonly string[], nowMs: number, ids?: { request: string; cancellations: readonly string[] }) => ({
  cancellationRequestId: ids?.request ?? randomUUID(),
  eventId,
  targets: ticketIds.map((ticketId, i) => ({ ticketId, cancellationId: ids?.cancellations[i] ?? randomUUID() })),
  nowMs,
});

describe('F-05-2 T1 R-T25 ② [ASVS v5.0.0-2.3.3] 회차 취소가 진행 중 양도 요청을 같은 트랜잭션에서 거둔다(PostgreSQL)', () => {
  test('F-05-2 T1 R-T25 ② ① 요청이 있는 표 셋과 없는 표 하나: 세 요청 WITHDRAWN·EVENT_CANCELLED·decided_at, OFFERED 0, 표 넷 REFUNDED·키 0, transferWithdrawn은 셋만', async () => {
    const w = world();
    const ids = await issue(w.a, w.event, 4);
    for (const t of ids) await registerKey(t, w.a);
    const offers = [];
    for (const t of ids.slice(0, 3)) offers.push(await offer(t, w.a, w.codeB));
    const at = clock.now() + 23 * MIN;
    const out = await tickets.eventCancel(cancelInput(w.event, ids, at));
    expect(out.map((o) => [o.ticketId, o.result, o.transferWithdrawn])).toEqual(ids.map((t, i) => [t, 'CANCELED', i < 3]));
    for (const id of offers) {
      const r = await offerRow(id);
      expect({ status: r.status, reason: r.withdraw_reason, decidedAt: r.decided_at?.getTime() }).toEqual({ status: 'WITHDRAWN', reason: 'EVENT_CANCELLED', decidedAt: at });
    }
    expect((await q<{ n: number }>("select count(*)::int as n from transfer_offer o join ticket t on t.id = o.ticket_id where t.event_id = $1 and o.status = 'OFFERED'", [w.event]))[0]!.n).toBe(0);
    for (const t of ids) {
      expect(await ticketRow(t)).toMatchObject({ status: 'REFUNDED', transfer_pending: false, account_id: w.a });
      expect(await activeKeys(t)).toBe(0);
    }
    const seen = await get(`/v1/transfers/${offers[0]}`, w.b);
    expect(seen.body).toMatchObject({ status: 'WITHDRAWN', withdrawReason: 'EVENT_CANCELLED' });
  });

  test('F-05-2 T1 R-T25 ② ② 같은 취소 ID로 다시 부르면 처음 결과이고 요청·표가 그대로다', async () => {
    const w = world();
    const [t] = await issue(w.a, w.event);
    const offerId = await offer(t!, w.a, w.codeB);
    const ids = { request: randomUUID(), cancellations: [randomUUID()] };
    const at = clock.now();
    const first = await tickets.eventCancel(cancelInput(w.event, [t!], at, ids));
    const row = await ticketRow(t!);
    const again = await tickets.eventCancel(cancelInput(w.event, [t!], at + 9 * MIN, ids));
    expect(again.map((o) => [o.ticketId, o.result, o.holderAccountId])).toEqual(first.map((o) => [o.ticketId, o.result, o.holderAccountId]));
    expect(await ticketRow(t!)).toEqual(row);
    expect((await offerRow(offerId)).decided_at?.getTime()).toBe(at);
  });

  test('F-05-2 T1 R-T25 ② ③ 되돌림: 다른 회차 표가 섞이면 TicketInputError로 트랜잭션째 되돌아가 거둔 요청이 하나도 남지 않는다', async () => {
    const w = world();
    const [t] = await issue(w.a, w.event);
    const [other] = await issue(w.a, randomUUID());
    const offerId = await offer(t!, w.a, w.codeB);
    await expect(tickets.eventCancel(cancelInput(w.event, [t!, other!], clock.now()))).rejects.toThrow();
    expect(await offerRow(offerId)).toMatchObject({ status: 'OFFERED', withdraw_reason: null, decided_at: null });
    expect(await ticketRow(t!)).toMatchObject({ status: 'TRANSFER_PENDING', transfer_pending: true });
  });

  test('F-05-2 T1 R-T25 ② ④ 장애 주입: 요청 거두기 쓰기가 실패하면 회차 취소 전체가 실패하고 두 표의 상태·키·취소 기록이 그대로다', async () => {
    const w = world();
    const ids = await issue(w.a, w.event, 2);
    for (const t of ids) await registerKey(t, w.a);
    const offers = [await offer(ids[0]!, w.a, w.codeB), await offer(ids[1]!, w.a, w.codeB)];
    const failing = ids[1]!;
    await withFailingTrigger({ table: 'transfer_offer', when: `new.ticket_id = '${failing}'::uuid and new.status = 'WITHDRAWN'`, ids: [failing] }, async () => {
      await expect(tickets.eventCancel(cancelInput(w.event, ids, clock.now()))).rejects.toThrow();
    });
    for (const [i, t] of ids.entries()) {
      expect(await ticketRow(t)).toMatchObject({ status: 'TRANSFER_PENDING', transfer_pending: true, key_revoked_at: null });
      expect(await activeKeys(t)).toBe(1);
      expect((await offerRow(offers[i]!)).status).toBe('OFFERED');
    }
    expect((await q<{ n: number }>('select count(*)::int as n from ticket_cancellation where ticket_id = any($1::uuid[])', [ids]))[0]!.n).toBe(0);
  });
});

describe('F-05-2 T2 R-T25 ② 운영자 취소가 진행 중 양도 요청을 거둔다(PostgreSQL, 정본 §7.4 ① FRAUD_LOCK)', () => {
  test('F-05-2 T2 R-T25 ② ① 요청 WITHDRAWN·FRAUD_LOCK·decided_at, 운영자 취소 기록·결과에 거둔 요청 ID, 없는 표는 빔, 다시 부르면 처음 결과', async () => {
    const w = world();
    const [t1, t2] = await issue(w.a, w.event, 2);
    await registerKey(t1!, w.a);
    const offerId = await offer(t1!, w.a, w.codeB);
    const at = clock.now() + 13 * MIN;
    const input = { approvalId: randomUUID(), fraudCaseId: randomUUID(), eventId: w.event, targets: [{ ticketId: t1!, expectedHolderAccountId: w.a }, { ticketId: t2!, expectedHolderAccountId: w.a }], nowMs: at };
    const out = await tickets.operatorCancel(input);
    expect(out.map((o) => [o.ticketId, o.result, o.withdrawnTransferOfferId])).toEqual([
      [t1, 'CANCELED', offerId],
      [t2, 'CANCELED', undefined],
    ]);
    const r = await offerRow(offerId);
    expect({ status: r.status, reason: r.withdraw_reason, decidedAt: r.decided_at?.getTime() }).toEqual({ status: 'WITHDRAWN', reason: 'FRAUD_LOCK', decidedAt: at });
    const rec = await q<{ ticket_id: string; withdrawn_transfer_offer_id: string | null }>('select ticket_id, withdrawn_transfer_offer_id from ticket_operator_cancellation where approval_id = $1 order by ticket_id', [input.approvalId]);
    expect(new Map(rec.map((x) => [x.ticket_id, x.withdrawn_transfer_offer_id]))).toEqual(new Map([
      [t1, offerId],
      [t2, null],
    ]));
    expect(await ticketRow(t1!)).toMatchObject({ status: 'REFUNDED', transfer_pending: false });
    expect(await activeKeys(t1!)).toBe(0);
    expect((await get(`/v1/transfers/${offerId}`, w.b)).body).toMatchObject({ status: 'WITHDRAWN', withdrawReason: 'OTHER' });
    const again = await tickets.operatorCancel({ ...input, nowMs: at + HOUR });
    expect(again.map((o) => [o.ticketId, o.result, o.withdrawnTransferOfferId])).toEqual(out.map((o) => [o.ticketId, o.result, o.withdrawnTransferOfferId]));
    expect((await offerRow(offerId)).decided_at?.getTime()).toBe(at);
  });
});

describe('F-05-2 T3 R-T25 ② [ASVS v5.0.0-2.3.4] 환급된 표는 받아도 쓸 수 없다(PostgreSQL)', () => {
  test('F-05-2 T3 R-T25 ② ① 회차 취소 뒤 수락은 409이고 표·보유자·키·버전이 그대로, 받는 사람 목록·상세·기기 키 등록에 그 표가 없다', async () => {
    const w = world();
    const [t] = await issue(w.a, w.event);
    const offerId = await offer(t!, w.a, w.codeB);
    await tickets.eventCancel(cancelInput(w.event, [t!], clock.now()));
    const row = await ticketRow(t!);
    const r = await post(`/v1/transfers/${offerId}/acceptance`, w.b);
    expect(r.status, r.raw).toBe(409);
    expect(String(r.body.type)).toContain('transfer-not-offered');
    expect(await ticketRow(t!)).toEqual(row);
    expect(row).toMatchObject({ status: 'REFUNDED', account_id: w.a });
    expect(((await get('/v1/tickets', w.b)).body.items as unknown[]).length).toBe(0);
    expect((await get(`/v1/tickets/${t}`, w.b)).status).toBe(404);
    // 받는 사람이 입장용 휴대폰을 TRANSFER로 등록하려 해도 보유자가 아니다(쓸 수 있는 키가 생기지 않는다)
    const reg = await deviceKeys.register({ ticketId: t!, accountId: w.b, keyId: new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]), publicKey: new Uint8Array(33).fill(3), reason: 'TRANSFER', nowMs: clock.now(), reauthVerified: false });
    expect(reg.kind).toBe('NOT_HOLDER');
    expect(await activeKeys(t!)).toBe(0);
  });

  test('F-05-2 T3 R-T25 ② ② 겹친 가드: 요청이 OFFERED인 채 표만 REFUNDED·VOIDED·CANCEL_REQUESTED·FLAGGED면 409 ticket-ended이고 아무것도 바뀌지 않는다', async () => {
    for (const status of ['REFUNDED', 'VOIDED', 'CANCEL_REQUESTED', 'FLAGGED']) {
      const w = world();
      const [t] = await issue(w.a, w.event);
      await registerKey(t!, w.a);
      const offerId = await offer(t!, w.a, w.codeB);
      await database.pool.query('update ticket set status = $2 where id = $1', [t, status]);
      const row = await ticketRow(t!);
      const r = await post(`/v1/transfers/${offerId}/acceptance`, w.b);
      expect(r.status, `${status} ${r.raw}`).toBe(409);
      expect(String(r.body.type)).toContain('ticket-ended');
      expect(await ticketRow(t!)).toEqual(row);
      expect((await offerRow(offerId)).status).toBe('OFFERED');
      expect(await activeKeys(t!)).toBe(1);
    }
  });

  test('F-05-2 T3 R-T25 ② ③ 수락이 먼저면 받은 사람이 보유자인 채 회차 취소가 표를 끝내고 결과 holderAccountId가 받는 사람이다', async () => {
    const w = world();
    const [t] = await issue(w.a, w.event);
    const offerId = await offer(t!, w.a, w.codeB);
    expect((await post(`/v1/transfers/${offerId}/acceptance`, w.b)).status).toBe(200);
    await registerKey(t!, w.b, 'TRANSFER');
    const [out] = await tickets.eventCancel(cancelInput(w.event, [t!], clock.now()));
    expect(out).toMatchObject({ ticketId: t, result: 'CANCELED', holderAccountId: w.b, transferWithdrawn: false });
    expect(await ticketRow(t!)).toMatchObject({ status: 'REFUNDED', account_id: w.b });
    expect(await activeKeys(t!)).toBe(0);
    expect((await offerRow(offerId)).status).toBe('ACCEPTED');
  });

  test('F-05-2 T3 R-T25 ② ④ 경합: 요청이 있는 표 30장에 회차 취소와 수락을 같은 순간에 넣기를 20번, 표마다 한쪽만 되고 끝에 쓸 수 있는 표·OFFERED·환급 두 번이 0이다', async () => {
    const ROUNDS = 20;
    const N = 30;
    let cancelFirst = 0;
    let acceptFirst = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const w = world();
      const ids = [...(await issue(w.a, w.event, 10)), ...(await issue(w.a, w.event, 10)), ...(await issue(w.a, w.event, 10))];
      expect(ids).toHaveLength(N);
      const offers = new Map<string, string>();
      for (const t of ids) offers.set(t, await offerDirect(t, w.a, w.b));
      const now = clock.now();
      // 장벽: 수락 절반 → 회차 취소 → 수락 나머지 차례로 같은 틱에 띄운다(풀 12개가 서로 다른 트랜잭션으로 겹친다)
      const accepts = ids.map((t) => () => transferStore.accept({ offerId: offers.get(t)!, accountId: w.b, nowMs: now }));
      const half = Math.floor(N / 2);
      const running = [...accepts.slice(0, half).map((f) => f()), tickets.eventCancel(cancelInput(w.event, ids, now)), ...accepts.slice(half).map((f) => f())];
      const settled = await Promise.allSettled(running);
      const cancel = settled[half]!;
      expect(cancel.status).toBe('fulfilled');
      const outcomes = (cancel as PromiseFulfilledResult<Awaited<ReturnType<typeof tickets.eventCancel>>>).value;
      const acceptResults = [...settled.slice(0, half), ...settled.slice(half + 1)];
      for (const [i, t] of ids.entries()) {
        const a = acceptResults[i]!;
        expect(a.status).toBe('fulfilled');
        const accepted = a.status === 'fulfilled' && (a.value as { kind: string }).kind === 'OK';
        const o = await offerRow(offers.get(t)!);
        const out = outcomes.find((x) => x.ticketId === t)!;
        expect(out.result).toBe('CANCELED');
        if (accepted) {
          acceptFirst += 1;
          expect(o.status).toBe('ACCEPTED');
          expect(out.holderAccountId).toBe(w.b);
        } else {
          cancelFirst += 1;
          expect({ status: o.status, reason: o.withdraw_reason }).toEqual({ status: 'WITHDRAWN', reason: 'EVENT_CANCELLED' });
          expect(out.holderAccountId).toBe(w.a);
        }
      }
      const summary = await q<{ open: number; usable: number; refunded: number; offered: number; cancels: number }>(
        `select
           (select count(*)::int from ticket where event_id = $1 and status in ('ACTIVE','TRANSFER_PENDING','ISSUED')) as usable,
           (select count(*)::int from ticket where event_id = $1 and status <> 'REFUNDED') as open,
           (select count(*)::int from ticket where event_id = $1 and status = 'REFUNDED' and key_revoked_at is not null) as refunded,
           (select count(*)::int from transfer_offer o join ticket t on t.id = o.ticket_id where t.event_id = $1 and o.status = 'OFFERED') as offered,
           (select count(*)::int from ticket_cancellation c join ticket t on t.id = c.ticket_id where t.event_id = $1) as cancels`,
        [w.event],
      );
      expect(summary[0]).toEqual({ usable: 0, open: 0, refunded: N, offered: 0, cancels: N });
    }
    expect(cancelFirst + acceptFirst).toBe(ROUNDS * N);
    // 경합이 실제로 양쪽 결과를 냈다(한쪽만 나오면 경합 없이 초록이 된다, RV-08)
    expect(cancelFirst, '취소가 먼저인 표가 없다').toBeGreaterThan(0);
    expect(acceptFirst, '수락이 먼저인 표가 없다').toBeGreaterThan(0);
  }, 240_000);
});

describe('F-05-2 T4·T5 [ASVS v5.0.0-8.2.2] 티켓 상세와 월렛 목록 짝(PostgreSQL)', () => {
  test('F-05-2 T4 ① 결제자 상세: transferable·transferDeadline·pendingTransfer, 남의 것·없는 것은 같은 404, private, no-store', async () => {
    const w = world();
    const [t] = await issue(w.a, w.event);
    const d = await get(`/v1/tickets/${t}`, w.a);
    expect(d.status, d.raw).toBe(200);
    expect(d.headers['cache-control']).toBe('private, no-store');
    expect(d.body).toMatchObject({ ticketId: t, eventId: w.event, transferable: true, transferLocked: false, receivedFromNickname: null, pendingTransfer: null, transferLockExpiresAt: null });
    expect(Date.parse(String(d.body.transferDeadline))).toBe(CLOSE);
    const nf1 = await get(`/v1/tickets/${t}`, w.b);
    const nf2 = await get(`/v1/tickets/${randomUUID()}`, w.a);
    expect([nf1.status, nf2.status]).toEqual([404, 404]);
    expect({ type: nf1.body.type, title: nf1.body.title }).toEqual({ type: nf2.body.type, title: nf2.body.title });
    for (const r of [nf1, nf2]) expect(r.headers['cache-control']).toBe('private, no-store');
  });

  test('F-05-2 T4 ② 경계: 잠금 기한 − 1ms는 잠김·기한, 기한 0ms는 풀림·null(실제 fraud_transfer_lock)', async () => {
    const w = world();
    const [t] = await issue(w.a, w.event);
    const expiresAtMs = clock.now() + 3 * HOUR + 41 * MIN;
    await transferStore.setTransferLock({ caseId: randomUUID(), version: 1, locked: true, eventId: w.event, accountIds: [w.a], expiresAtMs, nowMs: clock.now() });
    clock.advance(expiresAtMs - 1 - clock.now());
    const before = await get(`/v1/tickets/${t}`, w.a);
    expect(before.body.transferLocked).toBe(true);
    expect(Date.parse(String(before.body.transferLockExpiresAt))).toBe(expiresAtMs);
    clock.advance(1);
    const after = await get(`/v1/tickets/${t}`, w.a);
    expect({ locked: after.body.transferLocked, expires: after.body.transferLockExpiresAt }).toEqual({ locked: false, expires: null });
  });

  test('F-05-2 T5 ① 목록 항목의 칸은 모두 상세에 같은 값으로 있고, pendingTransfer는 요청 뒤 그 요청·철회 뒤 null이다', async () => {
    const w = world();
    const [t] = await issue(w.a, w.event);
    const pair = async () => {
      const item = ((await get('/v1/tickets', w.a)).body.items as Array<Record<string, unknown>>).find((i) => i.ticketId === t)!;
      const detail = (await get(`/v1/tickets/${t}`, w.a)).body;
      for (const [k, v] of Object.entries(item)) expect(detail[k], `목록 칸 ${k}`).toEqual(v);
      return item;
    };
    expect((await pair()).pendingTransfer).toBeNull();
    const offerId = await offer(t!, w.a, w.codeB);
    const withOffer = (await pair()).pendingTransfer as { offerId: string; expiresAt: string };
    expect(withOffer.offerId).toBe(offerId);
    expect(Date.parse(withOffer.expiresAt)).toBe(clock.now() + 48 * HOUR);
    expect((await post(`/v1/transfers/${offerId}/withdrawal`, w.a)).status).toBe(200);
    expect((await pair()).pendingTransfer).toBeNull();
  });
});

describe('F-05-2 T6 [ASVS v5.0.0-8.2.2] 받은 요청 목록(PostgreSQL)', () => {
  test('F-05-2 T6 ① 받는 사람 것만 최근 순·OFFERED 거르기·커서로 끝까지 겹침 0, 결제 정보 없음', async () => {
    const w = world();
    const ids = await issue(w.a, w.event, 5);
    const made: string[] = [];
    for (const t of ids) {
      made.push(await offer(t, w.a, w.codeB));
      clock.advance(2 * MIN);
    }
    expect((await post(`/v1/transfers/${made[2]}/withdrawal`, w.a)).status).toBe(200);
    const all = await get('/v1/transfers', w.b);
    expect(all.status, all.raw).toBe(200);
    expect(all.headers['cache-control']).toBe('private, no-store');
    expect((all.body.items as Array<{ offerId: string }>).map((i) => i.offerId)).toEqual([...made].reverse());
    const want = [...made].reverse().filter((id) => id !== made[2]);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 10; n++) {
      const page = await get(`/v1/transfers?status=OFFERED&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, w.b);
      expect(page.status, page.raw).toBe(200);
      seen.push(...(page.body.items as Array<{ offerId: string }>).map((i) => i.offerId));
      cursor = (page.body.nextCursor as string | null | undefined) ?? null;
      if (cursor === null) break;
    }
    expect(seen).toEqual(want);
    expect((await get('/v1/transfers', w.a)).body.items).toEqual([]);
    expect(all.raw.includes(w.a)).toBe(false);
  });
});

describe('F-05-2 T7 [ASVS v5.0.0-2.4.1] 받는 사람 조회 한도와 기록(PostgreSQL 0018 transfer_recipient_lookup)', () => {
  const lookup = (account: string, memberCode: string) => post('/v1/transfer-recipient-lookups', account, { body: { memberCode } });

  test('F-05-2 T7 ① 시도마다 기록 한 행(FOUND·NOT_FOUND·LIMITED·UNAVAILABLE), 기록에 회원 코드·찾은 계정 ID가 없다', async () => {
    const w = world();
    const me = randomUUID();
    const r1 = await lookup(me, w.codeB);
    const r2 = await lookup(me, 'ZZ9-NOPE');
    expect([r1.status, r2.status]).toEqual([200, 404]);
    for (let i = 0; i < 8; i++) await lookup(me, w.codeB);
    const limited = await lookup(me, w.codeB);
    expect(limited.status).toBe(429);
    const rows = await q<Record<string, unknown>>('select * from transfer_recipient_lookup where account_id = $1 order by looked_up_at, result', [me]);
    expect(rows.map((r) => r.result).sort()).toEqual([...Array(9).fill('FOUND'), 'LIMITED', 'NOT_FOUND'].sort());
    const text = JSON.stringify(rows);
    for (const secret of [w.codeB, 'ZZ9-NOPE', w.b]) expect(text.includes(secret), `기록에 ${secret}`).toBe(false);
    const logText = logs.join('\n');
    for (const secret of [w.codeB, w.b]) expect(logText.includes(secret), `서비스 기록 줄에 ${secret}`).toBe(false);
  });

  test('F-05-2 T7 ② 장애 주입: 조회 기록을 쓰지 못하면 503이고 identity를 부르지 않는다(닫힌 쪽)', async () => {
    const w = world();
    const me = randomUUID();
    const before = directory.calls.length;
    const r = await withFailingTrigger({ table: 'transfer_recipient_lookup', when: `new.account_id = '${me}'::uuid`, ids: [me] }, () => lookup(me, w.codeB));
    expect(r.status, r.raw).toBe(503);
    expect(String(r.body.type)).toContain('dependency-unavailable');
    expect('recipientRef' in r.body).toBe(false);
    expect(directory.calls.length).toBe(before);
  });

  test('F-05-2 T7 ③ 동시 12건이 들어와도 200·404 합은 10이고 나머지는 429다(계정 단위 직렬화)', async () => {
    const w = world();
    const me = randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => lookup(me, i % 2 === 0 ? w.codeB : 'ZZ9-NOPE')));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200 || s === 404)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });

  test('F-05-2 T7 ④ 경계(실제 DB, RV-03): Retry-After는 창에서 가장 오래된 조회가 빠질 때까지의 초이고, 첫 조회 + 60분 − 1ms는 429·Retry-After 1, + 60분은 200이다', async () => {
    const w = world();
    const me = randomUUID();
    const t0 = clock.now();
    expect((await lookup(me, w.codeB)).status).toBe(200);
    clock.advance(5 * MIN);
    for (let i = 0; i < 9; i++) expect((await lookup(me, w.codeB)).status).toBe(200);
    clock.advance(5 * MIN);
    const limited = await lookup(me, w.codeB);
    expect(limited.status, limited.raw).toBe(429);
    expect(String(limited.body.type)).toContain('too-many-requests');
    expect(limited.headers['retry-after']).toBe('3000');
    clock.advance(t0 + 60 * MIN - 1 - clock.now());
    const edge = await lookup(me, w.codeB);
    expect(edge.status).toBe(429);
    expect(edge.headers['retry-after']).toBe('1');
    clock.advance(1);
    expect((await lookup(me, w.codeB)).status).toBe(200);
    // 이제 창 안은 t0 + 5분의 아홉과 방금 하나: 다음은 429, 기다릴 초는 t0 + 65분까지
    const next = await lookup(me, w.codeB);
    expect(next.status).toBe(429);
    expect(next.headers['retry-after']).toBe('300');
  });

  test('F-05-2 T7 ⑤ identity 찾기가 실패하면 503이고 조회 기록에 UNAVAILABLE 한 행을 남긴다(RV-10)', async () => {
    const w = world();
    const me = randomUUID();
    directory.fail = true;
    let r: Res;
    try {
      r = await lookup(me, w.codeB);
    } finally {
      directory.fail = false;
    }
    expect(r.status, r.raw).toBe(503);
    expect(String(r.body.type)).toContain('dependency-unavailable');
    const rows = await q<{ result: string }>('select result from transfer_recipient_lookup where account_id = $1', [me]);
    expect(rows.map((x) => x.result)).toEqual(['UNAVAILABLE']);
  });
});

describe('F-05-2 T8 [ASVS v5.0.0-11.1.1] 돌려주기 다시 보냄(PostgreSQL)', () => {
  test('F-05-2 T8 ① 같은 키로 다시 보내면 첫 본문 그대로이고 보유자 바꿈·버전 증가·키 폐기는 한 번이다, 같은 키로 다른 표는 422', async () => {
    const w = world();
    const [t1, t2] = await issue(w.a, w.event, 2);
    for (const t of [t1!, t2!]) {
      const offerId = await offer(t, w.a, w.codeB);
      expect((await post(`/v1/transfers/${offerId}/acceptance`, w.b)).status).toBe(200);
      await registerKey(t, w.b, 'TRANSFER');
    }
    const v0 = Number((await ticketRow(t1!)).version);
    const revoked0 = await revokedKeys(t1!);
    const key = randomUUID();
    const first = await post(`/v1/tickets/${t1}/returns`, w.b, { key, reauth: 'token-1' });
    expect(first.status, first.raw).toBe(200);
    expect(await ticketRow(t1!)).toMatchObject({ account_id: w.a });
    expect(Number((await ticketRow(t1!)).version)).toBe(v0 + 1);
    expect(await revokedKeys(t1!)).toBe(revoked0 + 1);
    clock.advance(4 * MIN);
    const again = await post(`/v1/tickets/${t1}/returns`, w.b, { key, reauth: 'token-2' });
    expect(again.status, again.raw).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(Number((await ticketRow(t1!)).version)).toBe(v0 + 1);
    expect(await revokedKeys(t1!)).toBe(revoked0 + 1);
    const before2 = await ticketRow(t2!);
    const reused = await post(`/v1/tickets/${t2}/returns`, w.b, { key, reauth: 'token-3' });
    expect(reused.status, reused.raw).toBe(422);
    expect(String(reused.body.type)).toContain('idempotency-key-reused');
    expect(await ticketRow(t2!)).toEqual(before2);
    expect(await activeKeys(t2!)).toBe(1);
  });

  /** 받은 표 하나(A → B 수락, B의 TRANSFER 키 등록까지) */
  const givenTo = async (w: ReturnType<typeof world>): Promise<string> => {
    const [t] = await issue(w.a, w.event);
    const offerId = await offer(t!, w.a, w.codeB);
    expect((await post(`/v1/transfers/${offerId}/acceptance`, w.b)).status).toBe(200);
    await registerKey(t!, w.b, 'TRANSFER');
    return t!;
  };

  test('F-05-2 T8 ② 되돌림(RV-04): 돌려주기 기록 쓰기가 실패하면 5xx이고 보유자·버전·키·양도 표시가 그대로이며, 고친 뒤 같은 키로 다시 보내면 처리된다', async () => {
    const w = world();
    const t = await givenTo(w);
    const before = await ticketRow(t);
    const key = randomUUID();
    const failed = await withFailingTrigger({ table: 'ticket_return', when: `new.ticket_id = '${t}'::uuid`, ids: [t] }, () => post(`/v1/tickets/${t}/returns`, w.b, { key, reauth: 'token-1' }));
    expect(failed.status, failed.raw).toBeGreaterThanOrEqual(500);
    expect(failed.raw.includes('RETURNED')).toBe(false);
    expect(await ticketRow(t)).toEqual(before);
    expect(await activeKeys(t)).toBe(1);
    const again = await post(`/v1/tickets/${t}/returns`, w.b, { key, reauth: 'token-2' });
    expect(again.status, again.raw).toBe(200);
    expect(again.body).toEqual({ ticketId: t, status: 'RETURNED' });
    expect(await ticketRow(t)).toMatchObject({ account_id: w.a });
    expect(Number((await ticketRow(t)).version)).toBe(Number(before.version) + 1);
    expect(await activeKeys(t)).toBe(0);
  });

  test('F-05-2 T8 ③ 동시(RV-06): 같은 키 돌려주기 두 건이 함께 오면 둘 다 같은 200이거나 하나가 409 idempotency-request-in-progress이고 보유자 바꿈·키 폐기는 한 번이다', async () => {
    const w = world();
    const t = await givenTo(w);
    const v0 = Number((await ticketRow(t)).version);
    const revoked0 = await revokedKeys(t);
    const key = randomUUID();
    const rs = await Promise.all([post(`/v1/tickets/${t}/returns`, w.b, { key, reauth: 'token-a' }), post(`/v1/tickets/${t}/returns`, w.b, { key, reauth: 'token-b' })]);
    for (const r of rs) {
      expect([200, 409], r.raw).toContain(r.status);
      if (r.status === 409) expect(String(r.body.type)).toContain('idempotency-request-in-progress');
      if (r.status === 200) expect(r.body).toEqual({ ticketId: t, status: 'RETURNED' });
    }
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(await ticketRow(t)).toMatchObject({ account_id: w.a });
    expect(Number((await ticketRow(t)).version)).toBe(v0 + 1);
    expect(await revokedKeys(t)).toBe(revoked0 + 1);
  });
});

describe('F-05-2 T3 R-T25 ② 운영자 취소 ↔ 수락 경합(PostgreSQL, RV-07)', () => {
  // 수락이 먼저인 표는 기대 보유자(결제자)가 아니어서 건너뛴다(transfer-refund §7.4 '결과 매핑' SKIPPED_HOLDER_CHANGED,
  // 잠금이 풀린 뒤 넘어간 받은 사람의 표는 취소하지 않는다). 그래서 끝 불변식은 'OFFERED 0·환급된 표를 받는 사람이 갖지 않음'이다
  test('F-05-2 T3 R-T25 ② ⑤ 요청이 있는 표 10장에 운영자 취소와 수락을 같은 순간에 넣기를 5번, 표마다 한쪽만 되고 환급된 표는 받는 사람이 쓸 수 없다', async () => {
    const ROUNDS = 5;
    const N = 10;
    let cancelFirst = 0;
    let acceptFirst = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const w = world();
      const ids = await issue(w.a, w.event, N);
      const offers = new Map<string, string>();
      for (const t of ids) offers.set(t, await offerDirect(t, w.a, w.b));
      const now = clock.now();
      const approvalId = randomUUID();
      const accepts = ids.map((t) => () => transferStore.accept({ offerId: offers.get(t)!, accountId: w.b, nowMs: now }));
      const half = Math.floor(N / 2);
      const running = [
        ...accepts.slice(0, half).map((f) => f()),
        tickets.operatorCancel({ approvalId, fraudCaseId: randomUUID(), eventId: w.event, targets: ids.map((ticketId) => ({ ticketId, expectedHolderAccountId: w.a })), nowMs: now }),
        ...accepts.slice(half).map((f) => f()),
      ];
      const settled = await Promise.allSettled(running);
      expect(settled.every((x) => x.status === 'fulfilled')).toBe(true);
      const outcomes = (settled[half] as PromiseFulfilledResult<Awaited<ReturnType<typeof tickets.operatorCancel>>>).value;
      const recs = new Map(
        (await q<{ ticket_id: string; withdrawn_transfer_offer_id: string | null }>('select ticket_id, withdrawn_transfer_offer_id from ticket_operator_cancellation where approval_id = $1', [approvalId])).map((r) => [r.ticket_id, r]),
      );
      for (const t of ids) {
        const o = await offerRow(offers.get(t)!);
        const out = outcomes.find((x) => x.ticketId === t)!;
        const row = await ticketRow(t);
        if (o.status === 'ACCEPTED') {
          acceptFirst += 1;
          expect(out.result).toBe('SKIPPED_HOLDER_CHANGED');
          expect(out.withdrawnTransferOfferId).toBeUndefined();
          expect(recs.get(t)?.withdrawn_transfer_offer_id).toBeNull();
          expect(row).toMatchObject({ account_id: w.b, status: 'ACTIVE' });
        } else {
          cancelFirst += 1;
          expect({ status: o.status, reason: o.withdraw_reason }).toEqual({ status: 'WITHDRAWN', reason: 'FRAUD_LOCK' });
          expect(out).toMatchObject({ result: 'CANCELED', withdrawnTransferOfferId: offers.get(t) });
          expect(recs.get(t)?.withdrawn_transfer_offer_id).toBe(offers.get(t));
          expect(row).toMatchObject({ account_id: w.a, status: 'REFUNDED' });
          expect(await activeKeys(t)).toBe(0);
        }
      }
      const left = await q<{ offered: number; refunded_held_by_b: number }>(
        `select
           (select count(*)::int from transfer_offer o join ticket t on t.id = o.ticket_id where t.event_id = $1 and o.status = 'OFFERED') as offered,
           (select count(*)::int from ticket where event_id = $1 and status = 'REFUNDED' and account_id = $2) as refunded_held_by_b`,
        [w.event, w.b],
      );
      expect(left[0]).toEqual({ offered: 0, refunded_held_by_b: 0 });
    }
    expect(cancelFirst + acceptFirst).toBe(ROUNDS * N);
    expect(cancelFirst, '취소가 먼저인 표가 없다').toBeGreaterThan(0);
    expect(acceptFirst, '수락이 먼저인 표가 없다').toBeGreaterThan(0);
  }, 180_000);
});
