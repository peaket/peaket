// F-05-12 O-T28 ③ 실제 PostgreSQL: 부스 허용 사용 표시와 기기 키 저장이 한 트랜잭션이라
// 같은 boothRequestId의 BOOTH 등록 20개가 동시에 와도 하나만 성공한다.
// 정본: docs/features/offline-gate.md §9.1 '서버 흐름', openapi createTicketDeviceKey, data.md booth_authorization.
//
// 시험 리뷰 TR-03·TR-14 반영:
// - 부스 저장소를 DeviceKeys에 따로 넣지 않고 DrizzleDeviceKeyStore에 넣는다. 사용 표시가 키 저장 트랜잭션 밖에서 불리면
//   동시 20회·감사(scanner_change) 실패 시나리오에서 잡힌다.
// - scanner_change(감사) 삽입을 한 번 실패시켜 부스 사용 표시·키가 함께 되돌아가는지 본다.
// - booth_authorization의 정본 칸(reverification_id·status·day_key·allowed_at·expires_at)을 단언한다.
import { randomUUID } from 'node:crypto';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { DrizzleDeviceKeyStore } from '../src/modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DeviceKeys, type ReauthGate } from '../src/modules/ticket/application/device-keys.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import type { PublicKeyJwk } from '../src/modules/ticket/domain/device-key.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-26T03:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-00000000e001';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-00000000e002';
const DEVICE = '0190f3a1-7c2e-7a00-8000-00000000e003';
const CODE_HASH = 'a'.repeat(64);
const CODE_MS = 10 * 60_000;
const quiet = { verify: async () => true } satisfies ReauthGate;

let pg: PostgresContainer;
let database: Database;
let ticketSvc: TicketService;
let ticketId: string;
let booth: { createRequest(i: unknown): Promise<unknown>; authorize(i: unknown): Promise<unknown> } | undefined;
let keys: DeviceKeys;

async function publicJwk(): Promise<PublicKeyJwk> {
  return (await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)) as PublicKeyJwk;
}

function requireBooth(): NonNullable<typeof booth> {
  expect(booth, '구현 전: DrizzleBoothStore가 없다').toBeDefined();
  return booth!;
}

async function issue(startsAtMs = NOW - 1, seatLabels?: string[]): Promise<string> {
  const issued = await ticketSvc.issue({ orderId: randomUUID(), eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [randomUUID()], issueGeneration: 0, eventStartsAtMs: startsAtMs, ...(seatLabels ? { seatLabels } : {}) } as unknown as Parameters<typeof ticketSvc.issue>[0]); // type-escape: seatLabels는 구현 뒤 생긴다
  return issued.tickets[0]!.ticketId;
}

async function requestAndAllow(ticket: string): Promise<{ boothRequestId: string; reverificationId: string }> {
  const b = requireBooth();
  const reverificationId = randomUUID();
  const created = (await b.createRequest({ ticketId: ticket, accountId: ACCOUNT, codeHash: CODE_HASH, nowMs: NOW, dayKey: '2026-11-26', expiresAtMs: NOW + CODE_MS, reverificationId })) as { kind: string; boothRequestId: string };
  expect(created.kind).toBe('created');
  // PENDING에도 코드 만료 시각을 expires_at에 적는다(IR-05). 허용 전에는 그 값이 코드 만료와 같다
  const pending = await database.pool.query<{ code_expires_at: Date; expires_at: Date | null }>('select code_expires_at, expires_at from booth_authorization where id = $1', [created.boothRequestId]);
  expect(pending.rows[0]!.expires_at?.getTime()).toBe(pending.rows[0]!.code_expires_at.getTime());
  const allowed = (await b.authorize({ eventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, codeHash: CODE_HASH, nowMs: NOW, allowUntilMs: NOW + CODE_MS })) as { kind: string; ticketId: string };
  expect(allowed).toEqual(expect.objectContaining({ kind: 'authorized', ticketId: ticket }));
  return { boothRequestId: created.boothRequestId, reverificationId };
}

beforeAll(async () => {
  pg = await startPostgres();
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-f0512-booth-int', max: 12 });
  await migrateTicket(pg.url);
  const clock = fakeClock({ now: NOW });
  const gate = new DrizzleScannerGateStore(database);
  // 구현 뒤 생기는 부스 저장소. 기준 트리에서는 불러오기가 실패해 아래 시험이 booth 없음으로 떨어진다.
  try {
    const path = new URL('../src/modules/ticket/adapters/db/drizzle-booth-store.ts', import.meta.url).href;
    const mod = (await import(/* @vite-ignore */ path)) as unknown as { DrizzleBoothStore: new (o: { database: Database }) => NonNullable<typeof booth> };
    booth = new mod.DrizzleBoothStore({ database });
  } catch {
    booth = undefined;
  }
  // 부스 저장소를 기기 키 저장소에 넘긴다: 사용 표시(used_at)가 키 저장과 같은 트랜잭션에서 적혀야 한다(TR-03)
  const deviceKeyStore = new DrizzleDeviceKeyStore({ database, changes: gate, ...(booth ? { booth } : {}) } as unknown as ConstructorParameters<typeof DrizzleDeviceKeyStore>[0]); // type-escape: booth 옵션은 구현 뒤 생긴다
  ticketSvc = new TicketService({ store: new DrizzleTicketStore({ database, changes: gate, deviceKeys: deviceKeyStore }), clock });
  keys = new DeviceKeys({ store: deviceKeyStore, clock, reauth: quiet });
  ticketId = await issue();
});
afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

describe('O-T28 ③ 실제 PostgreSQL BOOTH 등록 한 번', () => {
  test('O-T28 ③ 같은 부스 허용의 BOOTH 등록 20개가 동시에 와도 키 하나만 저장되고 사용 표시·감사 변경이 한 트랜잭션에 남는다', async () => {
    // IR-03: 저장소 유실의 보통 경우(서버에 옛 유효 키가 남음)에도 BOOTH는 부스에서 그 키를 바꾼다
    const oldKey = await keys.register({ ticketId, accountId: ACCOUNT, sessionId: randomUUID(), publicKeyJwk: await publicJwk(), reason: 'ISSUE' });
    const { boothRequestId, reverificationId } = await requestAndAllow(ticketId);
    const allowed = await database.pool.query<{ status: string; day_key: string; reverification_id: string; allowed_by: string; requested_at: Date; code_expires_at: Date; allowed_at: Date; expires_at: Date; used_at: Date | null }>(
      'select status, day_key, reverification_id, allowed_by, requested_at, code_expires_at, allowed_at, expires_at, used_at from booth_authorization where id = $1',
      [boothRequestId],
    );
    expect(allowed.rows[0]).toMatchObject({ status: 'ALLOWED', day_key: '2026-11-26', reverification_id: reverificationId, allowed_by: ACCOUNT, used_at: null });
    expect(allowed.rows[0]!.code_expires_at.getTime() - allowed.rows[0]!.requested_at.getTime()).toBe(CODE_MS);
    expect(allowed.rows[0]!.expires_at.getTime() - allowed.rows[0]!.allowed_at.getTime()).toBe(CODE_MS);

    const jwks = await Promise.all(Array.from({ length: 20 }, () => publicJwk()));
    const results = await Promise.allSettled(jwks.map((publicKeyJwk) => keys.register({ ticketId, accountId: ACCOUNT, sessionId: randomUUID(), publicKeyJwk, reason: 'BOOTH', boothRequestId })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(19);
    expect(rejected.every((r) => ['BOOTH_NOT_ALLOWED', 'REISSUE_AT_BOOTH'].includes((r.reason as { code?: string }).code ?? ''))).toBe(true);

    const keyRows = await database.pool.query<{ n: number }>('select count(*)::int n from device_key where ticket_id = $1 and revoked_at is null', [ticketId]);
    expect(keyRows.rows[0]!.n).toBe(1);
    // 옛 키는 폐기되고 새 키가 그 자리를 대신한다
    const oldRows = await database.pool.query<{ n: number }>('select count(*)::int n from device_key where ticket_id = $1 and key_id = $2 and revoked_at is not null', [ticketId, Buffer.from(oldKey.keyId, 'base64url')]);
    expect(oldRows.rows[0]!.n).toBe(1);
    const boothRows = await database.pool.query<{ used: boolean; status: string }>('select used_at is not null used, status from booth_authorization where id = $1', [boothRequestId]);
    expect(boothRows.rows[0]).toEqual({ used: true, status: 'USED' });
    const changeRows = await database.pool.query<{ n: number }>(`select count(*)::int n from scanner_change where event_id = $1 and kind = 'KEY_REGISTERED' and payload->>'ticketId' = $2`, [EVENT, ticketId]);
    expect(changeRows.rows[0]!.n).toBe(2);
    const revokedRows = await database.pool.query<{ n: number }>(`select count(*)::int n from scanner_change where event_id = $1 and kind = 'KEY_REVOKED' and payload->>'ticketId' = $2`, [EVENT, ticketId]);
    expect(revokedRows.rows[0]!.n).toBe(1);
  });

  test('O-T28 ③ 감사(scanner_change) 삽입이 실패하면 부스 사용 표시·기기 키가 함께 되돌아가고, 다시 시도하면 201이다', async () => {
    const ticket = await issue();
    const { boothRequestId } = await requestAndAllow(ticket);
    await database.pool.query('create table f0512_change_fault (id int primary key, fail boolean not null)');
    await database.pool.query('insert into f0512_change_fault (id, fail) values (1, true)');
    await database.pool.query(`
      create or replace function f0512_fail_change() returns trigger language plpgsql as $$
      begin
        if new.kind = 'KEY_REGISTERED' then
          if (select fail from f0512_change_fault where id = 1) then
            raise exception 'f0512 fault: scanner_change insert';
          end if;
        end if;
        return new;
      end $$;
    `);
    await database.pool.query('create trigger f0512_fail_change before insert on scanner_change for each row execute function f0512_fail_change()');

    await expect(keys.register({ ticketId: ticket, accountId: ACCOUNT, sessionId: randomUUID(), publicKeyJwk: await publicJwk(), reason: 'BOOTH', boothRequestId })).rejects.toBeTruthy();
    // 트리거가 같은 트랜잭션에서 fail=false를 쓰면 그 갱신도 되돌아간다. 실패를 본 뒤 바깥 연결에서 한 번만 푼다
    await database.pool.query('update f0512_change_fault set fail = false where id = 1');
    const afterFail = await database.pool.query<{ keys: number; used: boolean; status: string }>(
      'select (select count(*)::int from device_key where ticket_id = $1 and revoked_at is null) keys, used_at is not null used, status from booth_authorization where id = $2',
      [ticket, boothRequestId],
    );
    expect(afterFail.rows[0]).toEqual({ keys: 0, used: false, status: 'ALLOWED' });

    const ok = await keys.register({ ticketId: ticket, accountId: ACCOUNT, sessionId: randomUUID(), publicKeyJwk: await publicJwk(), reason: 'BOOTH', boothRequestId });
    expect(ok.keyId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    const afterRetry = await database.pool.query<{ keys: number; used: boolean }>(
      'select (select count(*)::int from device_key where ticket_id = $1 and revoked_at is null) keys, used_at is not null used from booth_authorization where id = $2',
      [ticket, boothRequestId],
    );
    expect(afterRetry.rows[0]).toEqual({ keys: 1, used: true });
  });
});
