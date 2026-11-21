// ticket-svc 기기 키 실제 PostgreSQL 통합 시험(BUILD_ORDER GAT-140, R-561).
// 0003_device_key.sql 적용·재적용, 등록·재발급 24시간 1회·폐기·취소 폐기, package keys/revokedKeyIds,
// 스캔 keyId 대조(유효·폐기·모름·형식 오류)를 실제 DB에서 본다.
import 'reflect-metadata';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { exportJWK, generateKeyPair } from 'jose';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';
import { DrizzleDeviceKeyStore } from '../src/modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DeviceKeys, type ReauthGate } from '../src/modules/ticket/application/device-keys.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import type { PublicKeyJwk } from '../src/modules/ticket/domain/device-key.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000101';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000102';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000103';
const SESSION = '0190f3a1-7c2e-7a00-8000-000000000104';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000105';
const ORDER_A = '0190f3a1-7c2e-7a00-8000-000000000111';
const ORDER_B = '0190f3a1-7c2e-7a00-8000-000000000112';
const ORDER_C = '0190f3a1-7c2e-7a00-8000-000000000113';
const ORDER_D = '0190f3a1-7c2e-7a00-8000-000000000114';
const ORDER_E = '0190f3a1-7c2e-7a00-8000-000000000115';
const ORDER_F = '0190f3a1-7c2e-7a00-8000-000000000116';
const ORDER_G = '0190f3a1-7c2e-7a00-8000-000000000117';
const ORDER_H = '0190f3a1-7c2e-7a00-8000-000000000118';
const ORDER_I = '0190f3a1-7c2e-7a00-8000-000000000119';
const ORDER_J = '0190f3a1-7c2e-7a00-8000-00000000011a';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-000000000121';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-000000000122';
const SEAT_C = '0190f3a1-7c2e-7a00-8000-000000000123';
const SEAT_D = '0190f3a1-7c2e-7a00-8000-000000000124';
const SEAT_E = '0190f3a1-7c2e-7a00-8000-000000000125';
const SEAT_F = '0190f3a1-7c2e-7a00-8000-000000000126';
const SEAT_G = '0190f3a1-7c2e-7a00-8000-000000000127';
const SEAT_H = '0190f3a1-7c2e-7a00-8000-000000000128';
const SEAT_I = '0190f3a1-7c2e-7a00-8000-000000000129';
const SEAT_J = '0190f3a1-7c2e-7a00-8000-00000000012a';
const CANCEL = '0190f3a1-7c2e-7a00-8000-000000000131';
// BAT-350 O-T45(같은 키 다시 등록·keyId 맞물림)
const ORDER_K = '0190f3a1-7c2e-7a00-8000-00000000011b';
const ORDER_L = '0190f3a1-7c2e-7a00-8000-00000000011c';
const ORDER_M = '0190f3a1-7c2e-7a00-8000-00000000011d';
const ORDER_N = '0190f3a1-7c2e-7a00-8000-00000000011e';
const SEAT_K = '0190f3a1-7c2e-7a00-8000-00000000012b';
const SEAT_L = '0190f3a1-7c2e-7a00-8000-00000000012c';
const SEAT_M = '0190f3a1-7c2e-7a00-8000-00000000012d';
const SEAT_N = '0190f3a1-7c2e-7a00-8000-00000000012e';

/** 구현과 따로 계산해 둔 시험 벡터(docs/api/vectors/qr-v1-device-key.v1.json, ADR-0336 결정 6) */
interface QrVector {
  publicKeyJwkAsExported: PublicKeyJwk;
  keyIdB64u: string;
  compressedPublicKeyB64u: string;
  negative: { otherKeyIdB64u: string };
}
const vector = JSON.parse(readFileSync(new URL('../../../docs/api/vectors/qr-v1-device-key.v1.json', import.meta.url), 'utf8')) as QrVector;

let pg: PostgresContainer;
let database: Database;
let gate: DrizzleScannerGateStore;
let deviceKeyStore: DrizzleDeviceKeyStore;
let ticketSvc: TicketService;
let keys: DeviceKeys;
let reauthKeys: DeviceKeys;
let clock: ReturnType<typeof fakeClock>;

const reauth: ReauthGate = { verify: async () => true };

async function publicJwk(): Promise<PublicKeyJwk> {
  return (await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)) as PublicKeyJwk;
}

async function issueTicket(orderId: string, seatId: string) {
  const r = await ticketSvc.issue({
    orderId,
    eventId: EVENT,
    payerAccountId: ACCOUNT,
    seatIds: [seatId],
    issueGeneration: 0,
    eventStartsAtMs: NOW + 86_400_000,
  });
  return r.tickets[0]!;
}

const scan = (ticketId: string, keyId: string, n: number): ScanEventInput => ({
  id: randomUUID(),
  eventId: EVENT,
  ticketId,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result: 'PASS',
  gateZone: '동문',
  scannedAtDevice: new Date(NOW + n * 1000).toISOString(),
  knownSeq: 0,
  deviceSeq: n,
  keyId,
});

beforeAll(async () => {
  pg = await startPostgres();
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-device-key-int', max: 8 });
  await migrateTicket(pg.url);
  clock = fakeClock({ now: NOW });
  gate = new DrizzleScannerGateStore(database);
  deviceKeyStore = new DrizzleDeviceKeyStore({ database, changes: gate });
  ticketSvc = new TicketService({ store: new DrizzleTicketStore({ database, changes: gate, deviceKeys: deviceKeyStore }), clock });
  keys = new DeviceKeys({ store: deviceKeyStore, clock });
  reauthKeys = new DeviceKeys({ store: deviceKeyStore, clock, reauth });
});

afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

describe('기기 키 PostgreSQL [GAT-140]', () => {
  test('0003_device_key.sql을 적용하고 다시 적용해도 같으며 표·부분 유니크·CHECK를 만든다', async () => {
    expect(await migrateTicket(pg.url)).toEqual([]);
    const tables = await database.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_name = 'device_key'");
    expect(tables.rows).toEqual([{ table_name: 'device_key' }]);
    const indexes = await database.pool.query("select indexname from pg_indexes where schemaname = 'public' and tablename = 'device_key' order by indexname");
    expect(indexes.rows.map((r) => r.indexname)).toEqual(expect.arrayContaining(['device_key_active_key', 'device_key_ticket_key_idx']));

    const ticketId = randomUUID();
    await expect(
      database.pool.query("insert into device_key (id, ticket_id, key_id, public_key, reason, registered_at) values ($1, $2, $3, $4, 'NOPE', now())", [
        randomUUID(),
        ticketId,
        Buffer.alloc(8),
        Buffer.alloc(33),
      ]),
    ).rejects.toThrow(/device_key_reason_check/);

    await database.pool.query("insert into device_key (id, ticket_id, key_id, public_key, reason, registered_at) values ($1, $2, $3, $4, 'ISSUE', now())", [
      randomUUID(),
      ticketId,
      Buffer.alloc(8, 1),
      Buffer.alloc(33, 2),
    ]);
    await expect(
      database.pool.query("insert into device_key (id, ticket_id, key_id, public_key, reason, registered_at) values ($1, $2, $3, $4, 'ISSUE', now())", [
        randomUUID(),
        ticketId,
        Buffer.alloc(8, 3),
        Buffer.alloc(33, 4),
      ]),
    ).rejects.toThrow(/device_key_active_key/);
  });

  test('ISSUE는 이전 키를 폐기하고, REISSUE는 재인증 뒤 24시간에 한 번만 되며 package에 유효 키·폐기 keyId가 실린다', async () => {
    const t = await issueTicket(ORDER_A, SEAT_A);
    const first = await keys.register({ ticketId: t.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'ISSUE' });
    const second = await reauthKeys.register({ ticketId: t.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'ISSUE' });
    expect(second.keyId).not.toBe(first.keyId);
    expect((await deviceKeyStore.activeKeysByEvent(EVENT)).get(t.ticketId)?.map((k) => k.keyId)).toEqual([second.keyId]);
    expect(await deviceKeyStore.revokedKeyIdsByEvent(EVENT)).toEqual(expect.arrayContaining([first.keyId]));
    expect(await deviceKeyStore.keyState(t.ticketId, Buffer.from(first.keyId, 'base64url'))).toBe('REVOKED');

    // 두 번째 ISSUE도 키 교체라 24시간 1회 한도에 센다. 같은 티켓의 REISSUE는 바로 막힌다.
    await expect(reauthKeys.register({ ticketId: t.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'REISSUE' })).rejects.toMatchObject({
      code: 'REISSUE_LIMIT',
    });
    const pkg = await gate.package({ eventId: EVENT, nowMs: NOW });
    const ticket = pkg.tickets.find((x) => x.ticketId === t.ticketId)!;
    expect(ticket.keys.map((k) => k.keyId)).toEqual([second.keyId]);
    expect(pkg.revokedKeyIds).toEqual(expect.arrayContaining([first.keyId]));
    const changes = await gate.changes({ eventId: EVENT, after: 0, limit: 1000 });
    expect(changes.changes.filter((c) => c.kind === 'KEY_REGISTERED' && c.payload.ticketId === t.ticketId)).toHaveLength(2);
    expect(changes.changes.filter((c) => c.kind === 'KEY_REVOKED' && c.payload.ticketId === t.ticketId)).toHaveLength(1);

    // 첫 등록 뒤 첫 REISSUE는 허용하고, 그다음 REISSUE는 24시간 한도로 막는다.
    const reissueTicket = await issueTicket(ORDER_J, SEAT_J);
    const base = await keys.register({ ticketId: reissueTicket.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'ISSUE' });
    const reissued = await reauthKeys.register({ ticketId: reissueTicket.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'REISSUE' });
    expect(reissued.keyId).not.toBe(base.keyId);
    clock.advance(1000);
    await expect(reauthKeys.register({ ticketId: reissueTicket.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'REISSUE' })).rejects.toMatchObject({
      code: 'REISSUE_LIMIT',
    });
    const pkg2 = await gate.package({ eventId: EVENT, nowMs: NOW });
    const ticket2 = pkg2.tickets.find((x) => x.ticketId === reissueTicket.ticketId)!;
    expect(ticket2.keys.map((k) => k.keyId)).toEqual([reissued.keyId]);
    expect(pkg2.revokedKeyIds).toEqual(expect.arrayContaining([base.keyId]));
  });

  test('취소는 같은 트랜잭션에서 유효 키를 폐기하고 KEY_REVOKED에 실제 keyId를 싣는다', async () => {
    const t = await issueTicket(ORDER_B, SEAT_B);
    const key = await keys.register({ ticketId: t.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'ISSUE' });
    expect(await ticketSvc.cancel({ orderId: ORDER_B, ticketIds: [t.ticketId], requestedByAccountId: ACCOUNT, cancellationId: CANCEL, nowMs: NOW })).toEqual([
      { ticketId: t.ticketId, result: 'REFUND_NOW' },
    ]);
    const row = (await database.pool.query('select revoked_at from device_key where ticket_id = $1', [t.ticketId])).rows[0];
    expect(row.revoked_at).not.toBeNull();
    const changes = await gate.changes({ eventId: EVENT, after: 0, limit: 1000 });
    const revoked = changes.changes.filter((c) => c.kind === 'KEY_REVOKED' && c.payload.ticketId === t.ticketId);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.payload.keyId).toBe(key.keyId);
    expect(await deviceKeyStore.keyState(t.ticketId, Buffer.from(key.keyId, 'base64url'))).toBe('REVOKED');
  });

  test('입장 시작 뒤 REISSUE는 재인증이 있어도 거절하고, TRANSFER는 보유자가 결제자와 다를 때만 된다', async () => {
    const t = await issueTicket(ORDER_G, SEAT_G);
    await keys.register({ ticketId: t.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'ISSUE' });
    await database.pool.query('update ticket set event_starts_at = $1 where id = $2', [new Date(NOW - 1), t.ticketId]);
    await expect(reauthKeys.register({ ticketId: t.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'REISSUE' })).rejects.toMatchObject({
      code: 'ENTRY_STARTED',
    });

    const payerTicket = await issueTicket(ORDER_H, SEAT_H);
    await expect(keys.register({ ticketId: payerTicket.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'TRANSFER' })).rejects.toMatchObject({
      code: 'TRANSFER_NOT_ALLOWED',
    });

    const transferred = await issueTicket(ORDER_I, SEAT_I);
    await database.pool.query('update ticket set account_id = $1 where id = $2', [OTHER, transferred.ticketId]);
    const registered = await keys.register({ ticketId: transferred.ticketId, accountId: OTHER, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'TRANSFER' });
    expect(registered.keyId).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  test('스캔 keyId가 유효하면 PASS, 폐기면 KEY_REVOKED, 모르면 KEY_UNKNOWN, 형식이 틀리면 INVALID_QR이다', async () => {
    const active = await issueTicket(ORDER_C, SEAT_C);
    const activeKey = await keys.register({ ticketId: active.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'ISSUE' });

    const rotated = await issueTicket(ORDER_D, SEAT_D);
    const oldKey = await keys.register({ ticketId: rotated.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'ISSUE' });
    const newKey = await reauthKeys.register({ ticketId: rotated.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await publicJwk(), reason: 'ISSUE' });

    const unknown = await issueTicket(ORDER_E, SEAT_E);
    const invalid = await issueTicket(ORDER_F, SEAT_F);
    const scans = [
      scan(active.ticketId, activeKey.keyId, 1),
      scan(rotated.ticketId, oldKey.keyId, 2),
      scan(unknown.ticketId, 'AAAAAAAAAAA', 3),
      scan(invalid.ticketId, 'short', 4),
    ];
    const result = await gate.acceptScans({ eventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, scans, nowMs: NOW });
    expect(result.acceptedIds).toHaveLength(4);
    const rows = (
      await database.pool.query('select id, result, reason from scan_event where event_id = $1 and id = any($2::uuid[])', [EVENT, result.acceptedIds])
    ).rows as { id: string; result: string; reason: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(scans[0]!.id)).toMatchObject({ result: 'PASS' });
    expect(byId.get(scans[1]!.id)).toMatchObject({ result: 'REJECT', reason: 'KEY_REVOKED' });
    expect(byId.get(scans[2]!.id)).toMatchObject({ result: 'REJECT', reason: 'KEY_UNKNOWN' });
    expect(byId.get(scans[3]!.id)).toMatchObject({ result: 'REJECT', reason: 'INVALID_QR' });
    expect(await deviceKeyStore.keyState(rotated.ticketId, Buffer.from(newKey.keyId, 'base64url'))).toBe('ACTIVE');
    expect(await deviceKeyStore.keyState(unknown.ticketId, Buffer.from('AAAAAAAAAAA', 'base64url'))).toBe('UNKNOWN');
  });

  // ---------- BAT-350 같은 키 다시 등록(O-T45 ③, offline-gate §2, ADR-0336 결정 4)·keyId 맞물림(O-T45 ④⑤) ----------
  // 행 수와 scanner_change 줄 수는 DB에서 직접 센다(저장소 함수의 돌려준 값만 보지 않는다)

  /** 그 티켓의 device_key 행·폐기 행, scanner_change의 KEY_REGISTERED·KEY_REVOKED 줄, 회차 전체 변경분 줄 */
  async function keyCounts(ticketId: string) {
    const k = (await database.pool.query('select count(*)::int as n, count(*) filter (where revoked_at is not null)::int as revoked from device_key where ticket_id = $1', [ticketId]))
      .rows[0] as { n: number; revoked: number };
    const c = (
      await database.pool.query(
        "select count(*) filter (where kind = 'KEY_REGISTERED')::int as registered, count(*) filter (where kind = 'KEY_REVOKED')::int as revoked from scanner_change where event_id = $1 and payload->>'ticketId' = $2",
        [EVENT, ticketId],
      )
    ).rows[0] as { registered: number; revoked: number };
    const all = (await database.pool.query('select count(*)::int as n from scanner_change where event_id = $1', [EVENT])).rows[0] as { n: number };
    return { keyRows: k.n, revokedRows: k.revoked, keyRegistered: c.registered, keyRevoked: c.revoked, eventChanges: all.n };
  }

  test('O-T45 ③ Drizzle: 다시 등록은 새 행·scanner_change 0이고 겹친 두 요청도 행 하나', async () => {
    const same = (ticketId: string) => ({ ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: vector.publicKeyJwkAsExported, reason: 'ISSUE' as const });

    // 처음 등록 뒤 같은 키를 다시 보낸다(응답을 잃은 월렛)
    const t = await issueTicket(ORDER_K, SEAT_K);
    const registeredAt = clock.now();
    expect(await keys.register(same(t.ticketId))).toEqual({ keyId: vector.keyIdB64u });
    const before = await keyCounts(t.ticketId);
    expect(before).toMatchObject({ keyRows: 1, revokedRows: 0, keyRegistered: 1, keyRevoked: 0 });
    clock.advance(1000);
    expect(await keys.register(same(t.ticketId))).toEqual({ keyId: vector.keyIdB64u });
    expect(await keyCounts(t.ticketId)).toEqual(before);
    const row = (await database.pool.query('select registered_at, revoked_at from device_key where ticket_id = $1', [t.ticketId])).rows[0] as { registered_at: Date; revoked_at: Date | null };
    expect(row.registered_at.getTime()).toBe(registeredAt);
    expect(row.revoked_at).toBeNull();

    // 다른 계정은 같은 공개키라도 404(NOT_FOUND)이고 아무것도 바꾸지 않는다
    await expect(keys.register({ ...same(t.ticketId), accountId: OTHER })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await keyCounts(t.ticketId)).toEqual(before);

    // 입장 시작 뒤에도 같은 키는 201이고 바꾸지 않는다. 다른 키는 지금 규칙대로 거절한다
    await database.pool.query('update ticket set event_starts_at = $1 where id = $2', [new Date(NOW - 1), t.ticketId]);
    expect(await keys.register(same(t.ticketId))).toEqual({ keyId: vector.keyIdB64u });
    await expect(keys.register({ ...same(t.ticketId), publicKeyJwk: await publicJwk() })).rejects.toMatchObject({ code: 'ENTRY_STARTED' });
    expect(await keyCounts(t.ticketId)).toEqual(before);

    // 24시간 한도에 세지 않는다: 다시 보낸 뒤에도 재인증 뒤 첫 교체는 된다(셌다면 REISSUE_LIMIT)
    const u = await issueTicket(ORDER_L, SEAT_L);
    expect(await keys.register(same(u.ticketId))).toEqual({ keyId: vector.keyIdB64u });
    expect(await keys.register(same(u.ticketId))).toEqual({ keyId: vector.keyIdB64u });
    const rotated = await reauthKeys.register({ ...same(u.ticketId), publicKeyJwk: await publicJwk() });
    expect(rotated.keyId).not.toBe(vector.keyIdB64u);
    expect(await keyCounts(u.ticketId)).toMatchObject({ keyRows: 2, revokedRows: 1, keyRegistered: 2, keyRevoked: 1 });

    // 겹친 두 요청(티켓 행 잠금으로 차례가 된다): 둘 다 201·같은 keyId, 행 하나, KEY_REGISTERED 한 줄
    const v = await issueTicket(ORDER_M, SEAT_M);
    const beforeBoth = await keyCounts(v.ticketId);
    const both = await Promise.all([keys.register(same(v.ticketId)), keys.register(same(v.ticketId))]);
    expect(both).toEqual([{ keyId: vector.keyIdB64u }, { keyId: vector.keyIdB64u }]);
    const afterBoth = await keyCounts(v.ticketId);
    expect(afterBoth).toMatchObject({ keyRows: 1, revokedRows: 0, keyRegistered: 1, keyRevoked: 0 });
    expect(afterBoth.eventChanges - beforeBoth.eventChanges).toBe(1);
  });

  test('O-T45 ④⑤ Drizzle: 목록 keys에 벡터 keyId·압축 공개키가 하나이고 등록한 keyId는 PASS, 다른 keyId는 KEY_UNKNOWN이다', async () => {
    const t = await issueTicket(ORDER_N, SEAT_N);
    expect(await keys.register({ ticketId: t.ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: vector.publicKeyJwkAsExported, reason: 'ISSUE' })).toEqual({
      keyId: vector.keyIdB64u,
    });
    const pkg = await gate.package({ eventId: EVENT, nowMs: NOW });
    expect(pkg.tickets.find((x) => x.ticketId === t.ticketId)!.keys).toEqual([{ keyId: vector.keyIdB64u, publicKey: vector.compressedPublicKeyB64u }]);
    const scans = [scan(t.ticketId, vector.negative.otherKeyIdB64u, 11), scan(t.ticketId, vector.keyIdB64u, 12)];
    const unknown = await gate.acceptScans({ eventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, scans: [scans[0]!], nowMs: NOW });
    const ok = await gate.acceptScans({ eventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, scans: [scans[1]!], nowMs: NOW });
    expect([...unknown.acceptedIds, ...ok.acceptedIds]).toHaveLength(2);
    const rows = (await database.pool.query('select id, result, reason from scan_event where event_id = $1 and id = any($2::uuid[])', [EVENT, scans.map((s) => s.id)])).rows as {
      id: string;
      result: string;
      reason: string | null;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(scans[0]!.id)).toMatchObject({ result: 'REJECT', reason: 'KEY_UNKNOWN' });
    expect(byId.get(scans[1]!.id)).toMatchObject({ result: 'PASS', reason: null });
  });
});
