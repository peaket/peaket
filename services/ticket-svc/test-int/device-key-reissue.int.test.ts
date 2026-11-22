// 재발급 403 가르기·입장 키 알림 보낼 표 실제 PostgreSQL 통합 시험(BUILD_ORDER GAT-020, F-05-1, docs/features/offline-gate.md §11 O-T47·O-T48·O-T6,
// ADR-0363 결정 2·4, docs/data.md device_key_notice, 마이그레이션 ticket 0012).
// - DrizzleDeviceKeyStore가 MemoryDeviceKeyStore와 같은 규칙(겹친 가드)을 지키는지, 알림 행이 등록과 같은 트랜잭션인지,
//   보내기 반복의 잠금 임대(FOR UPDATE SKIP LOCKED)·다시 보낼 때·정리를 실제 DB에서 본다. 행 수와 scanner_change 줄 수는 DB에서 직접 센다.
// - 재인증 확인은 포트(ReauthGate) 구현으로 바꿔 끼운다(토큰 'ok'만 통과). 확인기 자체는 test/device-key-reauth.test.ts와 연결 시험이 본다.
import 'reflect-metadata';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleDeviceKeyStore } from '../src/modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DeviceKeys, type ReauthGate } from '../src/modules/ticket/application/device-keys.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { deviceKeyMaterialOf, keyIdTextOf, type PublicKeyJwk } from '../src/modules/ticket/domain/device-key.js';
import { assembleDeviceKeys } from '../src/start.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

/** 시험 시각(KST 2026-11-23 16:20:00) */
const T0 = Date.parse('2026-11-23T07:20:00.000Z');
const DAY = 24 * 60 * 60_000;
const EVENT = '0193f2c0-0000-7000-8000-0000000c0051';
const ACCOUNT = '0193f2c0-0000-7000-8000-0000000c0052';
const SESSION = '0193f2c0-0000-7000-8000-0000000c0053';

let pg: PostgresContainer;
let database: Database;
let gate: DrizzleScannerGateStore;
let store: DrizzleDeviceKeyStore;
let tickets: TicketService;
let keys: DeviceKeys;
let clock: ReturnType<typeof fakeClock>;
let seq = 0;

const reauth: ReauthGate = { verify: async (token) => token === 'ok' };

async function deviceJwk(): Promise<PublicKeyJwk> {
  return (await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)) as PublicKeyJwk;
}
const keyIdOf = (jwk: PublicKeyJwk): string => keyIdTextOf(deviceKeyMaterialOf(jwk).keyId);
const hex = (n: number) => n.toString(16).padStart(12, '0');

/** 새 티켓 하나(회차 시작 = startsAtMs). 주문·좌석 ID는 시험마다 새로 */
async function ticket(startsAtMs = T0 + 3 * DAY): Promise<string> {
  seq += 1;
  const r = await tickets.issue({
    orderId: `0193f2c0-0000-7000-8001-${hex(seq)}`,
    eventId: EVENT,
    payerAccountId: ACCOUNT,
    seatIds: [`0193f2c0-0000-7000-8002-${hex(seq)}`],
    issueGeneration: 0,
    eventStartsAtMs: startsAtMs,
  });
  return r.tickets[0]!.ticketId;
}
const reg = (ticketId: string, publicKeyJwk: PublicKeyJwk, reason: 'ISSUE' | 'REISSUE', token?: string) =>
  keys.register({ ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk, reason, ...(token ? { reauthToken: token } : {}) });

/** 그 티켓의 device_key 행·폐기 행, scanner_change 줄, device_key_notice 행을 DB에서 센다 */
async function counts(ticketId: string) {
  const k = (await database.pool.query('select count(*)::int as n, count(*) filter (where revoked_at is not null)::int as revoked from device_key where ticket_id = $1', [ticketId])).rows[0] as { n: number; revoked: number };
  const c = (
    await database.pool.query(
      "select count(*) filter (where kind = 'KEY_REGISTERED')::int as registered, count(*) filter (where kind = 'KEY_REVOKED')::int as revoked from scanner_change where event_id = $1 and payload->>'ticketId' = $2",
      [EVENT, ticketId],
    )
  ).rows[0] as { registered: number; revoked: number };
  const n = (await database.pool.query('select count(*)::int as n from device_key_notice where ticket_id = $1', [ticketId])).rows[0] as { n: number };
  return { keyRows: k.n, revokedRows: k.revoked, keyRegistered: c.registered, keyRevoked: c.revoked, notices: n.n };
}
const activeKeyIds = async (ticketId: string) => ((await store.activeKeysByEvent(EVENT)).get(ticketId) ?? []).map((x) => x.keyId);
const noticesOf = async (ticketId: string) =>
  (
    await database.pool.query(
      'select n.id, n.type, n.account_id, n.attempts, n.created_at, n.next_attempt_at, n.sent_at, dk.key_id from device_key_notice n join device_key dk on dk.id = n.device_key_id where n.ticket_id = $1 order by n.created_at',
      [ticketId],
    )
  ).rows as { id: string; type: string; account_id: string; attempts: number; created_at: Date; next_attempt_at: Date; sent_at: Date | null; key_id: Buffer }[];

beforeAll(async () => {
  pg = await startPostgres();
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-device-key-reissue-int', max: 8 });
  await migrateTicket(pg.url);
  clock = fakeClock({ now: T0 });
  gate = new DrizzleScannerGateStore(database);
  store = new DrizzleDeviceKeyStore({ database, changes: gate });
  tickets = new TicketService({ store: new DrizzleTicketStore({ database, changes: gate, deviceKeys: store }), clock });
  keys = new DeviceKeys({ store, clock, reauth });
});

afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

describe('0012 device_key_notice [GAT-020]', () => {
  test('O-T48 0012_device_key_notice.sql을 적용하고 다시 적용해도 같으며 종류 CHECK·키당 한 행·보낼 행 색인을 만든다', async () => {
    expect(await migrateTicket(pg.url)).toEqual([]);
    const cols = (await database.pool.query("select column_name from information_schema.columns where table_name = 'device_key_notice' order by column_name")).rows.map((r) => r.column_name);
    // docs/data.md device_key_notice 칸(연락처·키 값 칸은 없다)
    expect(cols).toEqual(['account_id', 'attempts', 'created_at', 'device_key_id', 'id', 'next_attempt_at', 'sent_at', 'ticket_id', 'type']);
    const t = await ticket();
    await reg(t, await deviceJwk(), 'ISSUE');
    const dk = (await database.pool.query('select id from device_key where ticket_id = $1', [t])).rows[0] as { id: string };
    const insert = (type: string, id: string) =>
      database.pool.query('insert into device_key_notice (id, device_key_id, ticket_id, account_id, type, created_at, next_attempt_at) values ($1, $2, $3, $4, $5, now(), now())', [id, dk.id, t, ACCOUNT, type]);
    await expect(insert('KEY_REGISTERED', '0193f2c0-0000-7000-8003-000000000001')).rejects.toThrow(/device_key_notice_type_check/);
    await insert('DEVICE_KEY_REISSUED', '0193f2c0-0000-7000-8003-000000000002');
    await expect(insert('DEVICE_KEY_LATE_ISSUE', '0193f2c0-0000-7000-8003-000000000003')).rejects.toThrow(/device_key_notice_device_key_uq/);
    await database.pool.query('delete from device_key_notice where ticket_id = $1', [t]);
    const idx = (await database.pool.query("select indexname from pg_indexes where tablename = 'device_key_notice' order by indexname")).rows.map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(['device_key_notice_device_key_uq', 'device_key_notice_due_idx']));
  });
});

describe('O-T47 Drizzle 403 가르기 [GAT-020]', () => {
  test('O-T47 ① 입장 시작 전 재인증 없는 REISSUE는 REISSUE_REQUIRED이고 행·변경분·알림이 그대로다', async () => {
    const t = await ticket();
    await reg(t, await deviceJwk(), 'ISSUE');
    const before = await counts(t);
    await expect(reg(t, await deviceJwk(), 'REISSUE')).rejects.toMatchObject({ code: 'REISSUE_REQUIRED' });
    await expect(reg(t, await deviceJwk(), 'ISSUE')).rejects.toMatchObject({ code: 'REISSUE_REQUIRED' });
    expect(await counts(t)).toEqual(before);
    expect(before).toEqual({ keyRows: 1, revokedRows: 0, keyRegistered: 1, keyRevoked: 0, notices: 0 });
  });

  test('O-T47 ② 맞는 토큰의 REISSUE는 기기 A 키를 폐기하고 scanner_change에 KEY_REVOKED·KEY_REGISTERED가 한 줄씩 생기며 알림 행이 같은 트랜잭션에 하나다', async () => {
    const t = await ticket();
    const a = await deviceJwk();
    await reg(t, a, 'ISSUE');
    const before = await counts(t);
    clock.advance(1_000);
    const b = await deviceJwk();
    expect(await reg(t, b, 'REISSUE', 'ok')).toEqual({ keyId: keyIdOf(b) });
    const after = await counts(t);
    expect({ ...after, keyRegistered: after.keyRegistered - before.keyRegistered, keyRevoked: after.keyRevoked - before.keyRevoked }).toEqual({ keyRows: 2, revokedRows: 1, keyRegistered: 1, keyRevoked: 1, notices: 1 });
    expect(await activeKeyIds(t)).toEqual([keyIdOf(b)]);
    expect(await store.keyState(t, Buffer.from(keyIdOf(a), 'base64url'))).toBe('REVOKED');
    const [n] = await noticesOf(t);
    expect({ type: n!.type, account: n!.account_id, attempts: n!.attempts, sent: n!.sent_at, keyId: n!.key_id.toString('base64url'), created: n!.created_at.getTime() }).toEqual({
      type: 'DEVICE_KEY_REISSUED',
      account: ACCOUNT,
      attempts: 0,
      sent: null,
      keyId: keyIdOf(b),
      created: clock.now(),
    });
  });

  test('O-T47 ⑥ 입장 시작 뒤 다른 키가 유효하면 맞는 토큰의 REISSUE·ISSUE와 토큰 없는 ISSUE 모두 REISSUE_AT_BOOTH이고 행·폐기·변경분·알림이 그대로다', async () => {
    const t = await ticket();
    await reg(t, await deviceJwk(), 'ISSUE');
    await database.pool.query('update ticket set event_starts_at = $1 where id = $2', [new Date(clock.now() - 1), t]);
    const before = await counts(t);
    const revokedBefore = await store.revokedKeyIdsByEvent(EVENT);
    for (const [reason, token] of [
      ['REISSUE', 'ok'],
      ['ISSUE', 'ok'],
      ['ISSUE', undefined],
    ] as const) {
      await expect(reg(t, await deviceJwk(), reason, token), `${reason} ${token}`).rejects.toMatchObject({ code: 'REISSUE_AT_BOOTH' });
    }
    expect(await counts(t)).toEqual(before);
    expect(await store.revokedKeyIdsByEvent(EVENT)).toEqual(revokedBefore);
  });

  test('O-T47 ⑦ 입장 시작 뒤 키가 없는 티켓은 토큰 없는 ISSUE가 ENTRY_STARTED이고 맞는 토큰 ISSUE가 등록되며 DEVICE_KEY_LATE_ISSUE 알림 행이 하나다', async () => {
    const t = await ticket(clock.now() - 60_000);
    await expect(reg(t, await deviceJwk(), 'ISSUE')).rejects.toMatchObject({ code: 'ENTRY_STARTED' });
    expect(await counts(t)).toEqual({ keyRows: 0, revokedRows: 0, keyRegistered: 0, keyRevoked: 0, notices: 0 });
    const b = await deviceJwk();
    expect(await reg(t, b, 'ISSUE', 'ok')).toEqual({ keyId: keyIdOf(b) });
    expect(await counts(t)).toEqual({ keyRows: 1, revokedRows: 0, keyRegistered: 1, keyRevoked: 0, notices: 1 });
    expect((await noticesOf(t)).map((n) => n.type)).toEqual(['DEVICE_KEY_LATE_ISSUE']);
  });

  test('O-T47 ⑤ ② 뒤 23시간 59분의 두 번째 REISSUE는 REISSUE_LIMIT이고 24시간 정각부터 된다', async () => {
    const t = await ticket(clock.now() + 5 * DAY);
    await reg(t, await deviceJwk(), 'ISSUE');
    const at = clock.now();
    await reg(t, await deviceJwk(), 'REISSUE', 'ok');
    clock.advance(DAY - 60_000);
    await expect(reg(t, await deviceJwk(), 'REISSUE', 'ok')).rejects.toMatchObject({ code: 'REISSUE_LIMIT' });
    clock.advance(at + DAY - 1 - clock.now());
    await expect(reg(t, await deviceJwk(), 'REISSUE', 'ok')).rejects.toMatchObject({ code: 'REISSUE_LIMIT' });
    clock.advance(1);
    const c = await deviceJwk();
    expect(await reg(t, c, 'REISSUE', 'ok')).toEqual({ keyId: keyIdOf(c) });
    expect((await counts(t)).notices).toBe(2);
  });

  test('O-T48 같은 키 다시 등록과 실패한 등록은 알림 행이 0이다', async () => {
    const t = await ticket();
    const a = await deviceJwk();
    await reg(t, a, 'ISSUE');
    expect(await reg(t, a, 'ISSUE')).toEqual({ keyId: keyIdOf(a) });
    expect(await reg(t, a, 'REISSUE', 'ok')).toEqual({ keyId: keyIdOf(a) });
    await expect(reg(t, await deviceJwk(), 'REISSUE')).rejects.toMatchObject({ code: 'REISSUE_REQUIRED' });
    expect(await counts(t)).toEqual({ keyRows: 1, revokedRows: 0, keyRegistered: 1, keyRevoked: 0, notices: 0 });
  });

  test('O-T48 알림 행을 적지 못하면 키 교체도 되돌아간다(같은 트랜잭션)', async () => {
    const t = await ticket();
    const a = await deviceJwk();
    await reg(t, a, 'ISSUE');
    const before = await counts(t);
    // 이 티켓의 알림 행만 막는 제약(시험 동안만). 등록이 같은 트랜잭션이면 키·변경분도 남지 않는다
    await database.pool.query(`alter table device_key_notice add constraint f051_block_notice check (ticket_id <> '${t}') not valid`);
    try {
      await expect(reg(t, await deviceJwk(), 'REISSUE', 'ok')).rejects.toThrow();
    } finally {
      await database.pool.query('alter table device_key_notice drop constraint f051_block_notice');
    }
    expect(await counts(t)).toEqual(before);
    expect(await activeKeyIds(t)).toEqual([keyIdOf(a)]);
  });
});

describe('O-T48 보내기 반복 임대·다시 보내기·정리(Drizzle) [GAT-020]', () => {
  test('O-T48 두 파드가 겹쳐 잡아도(FOR UPDATE SKIP LOCKED) 같은 행을 둘이 잡지 않고, 임대가 끝나면 다시 잡으며 보낸 횟수가 는다', async () => {
    const mine: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const t = await ticket();
      await reg(t, await deviceJwk(), 'ISSUE');
      await reg(t, await deviceJwk(), 'REISSUE', 'ok');
      mine.push((await noticesOf(t))[0]!.id);
    }
    const other = new DrizzleDeviceKeyStore({ database, changes: gate });
    const now = clock.now() + 10_000;
    const [x, y] = await Promise.all([store.claimDue(now, 1000, 60_000), other.claimDue(now, 1000, 60_000)]);
    const xs = new Set(x.map((n) => n.id));
    expect(y.filter((n) => xs.has(n.id))).toEqual([]);
    const both = new Set([...x, ...y].map((n) => n.id));
    for (const id of mine) expect(both.has(id), id).toBe(true);
    for (const n of [...x, ...y].filter((r) => mine.includes(r.id))) expect(n.attempts).toBe(1);
    // 임대 중(60초)에는 다시 잡지 않는다
    expect((await store.claimDue(now + 59_999, 1000, 60_000)).filter((n) => mine.includes(n.id))).toEqual([]);
    // 임대가 끝나면(그 파드가 죽었다) 다시 잡고 보낸 횟수가 2다
    const again = (await store.claimDue(now + 60_000, 1000, 60_000)).filter((n) => mine.includes(n.id));
    expect(again.map((n) => n.id).sort()).toEqual([...mine].sort());
    expect(again.every((n) => n.attempts === 2)).toBe(true);
    // 정리: 시험 행을 보냄으로 적는다(다음 시험의 잡기에 섞이지 않게)
    for (const id of mine) await store.markSent(id, now);
  });

  test('O-T48 core 503 두 번 뒤 되살리면 행마다 보냄이 적히고 1분 전에는 다시 보내지 않으며 보낸 행은 7일 뒤 지운다', async () => {
    // 다른 시험이 남긴 보내지 않은 행은 보냄으로 적어 둔다(이 시험이 센 행만 보게)
    await database.pool.query('update device_key_notice set sent_at = $1 where sent_at is null', [new Date(clock.now())]);
    const answers = [503, 503];
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input instanceof Request ? input.url : input), body: JSON.parse(String(init?.body)) });
      const s = answers.shift() ?? 202;
      return new Response(JSON.stringify(s === 202 ? { created: 1, duplicate: 0 } : { status: s }), { status: s, headers: { 'content-type': 'application/json' } });
    };
    const { deviceKeys, notices } = assembleDeviceKeys({ store, reauth, clock, coreHttpUrl: 'http://core-svc.f051.test:7311', internalToken: 'f051-int', fetch: fetchImpl });
    const t1 = await ticket();
    await deviceKeys.register({ ticketId: t1, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await deviceJwk(), reason: 'ISSUE' });
    await deviceKeys.register({ ticketId: t1, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await deviceJwk(), reason: 'REISSUE', reauthToken: 'ok' });
    const t2 = await ticket(clock.now() - 1);
    await deviceKeys.register({ ticketId: t2, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await deviceJwk(), reason: 'ISSUE', reauthToken: 'ok' });
    const start = clock.now();
    expect(await notices!.runOnce()).toMatchObject({ attempted: 2, sent: 0, retried: 2 });
    const rows = [...(await noticesOf(t1)), ...(await noticesOf(t2))];
    expect(rows.map((r) => [r.attempts, r.sent_at, r.next_attempt_at.getTime()])).toEqual([
      [1, null, start + 60_000],
      [1, null, start + 60_000],
    ]);
    expect(await notices!.backlog()).toMatchObject({ count: 2 });
    clock.advance(60_000 - 1);
    expect(await notices!.runOnce()).toMatchObject({ attempted: 0 });
    clock.advance(1);
    expect(await notices!.runOnce()).toMatchObject({ attempted: 2, sent: 2 });
    const sentAt = clock.now();
    for (const r of [...(await noticesOf(t1)), ...(await noticesOf(t2))]) expect([r.attempts, r.sent_at?.getTime()]).toEqual([2, sentAt]);
    expect(await notices!.backlog()).toEqual({ count: 0, oldestSeconds: 0 });
    // 보낸 본문: notify §4.7의 다섯 칸, 등록 시각은 키 등록 시각
    expect(calls.slice(2).map((c) => (c.body as { type: string }).type).sort()).toEqual(['DEVICE_KEY_LATE_ISSUE', 'DEVICE_KEY_REISSUED']);
    for (const c of calls) expect(Object.keys(c.body as object).sort()).toEqual(['accountId', 'noticeId', 'registeredAtMs', 'ticketId', 'type']);
    // 7일 [가정] 뒤 지운다(7일 1ms 전에는 남는다)
    clock.advance(7 * DAY - 1);
    await notices!.runOnce();
    expect((await counts(t1)).notices + (await counts(t2)).notices).toBe(2);
    clock.advance(2);
    await notices!.runOnce();
    expect((await counts(t1)).notices + (await counts(t2)).notices).toBe(0);
  });
});
