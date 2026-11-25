// F-05-12 O-T28 ③ 실제 PostgreSQL: 부스 허용 사용 표시와 기기 키 저장이 한 트랜잭션이라
// 같은 boothRequestId의 BOOTH 등록 20개가 동시에 와도 하나만 성공한다.
// 정본: docs/features/offline-gate.md §9.1 '서버 흐름', openapi createTicketDeviceKey, data.md booth_authorization.
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
let booth: { createRequest(i: unknown): Promise<unknown>; authorize(i: unknown): Promise<unknown> };
let keys: DeviceKeys;

async function publicJwk(): Promise<PublicKeyJwk> {
  return (await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)) as PublicKeyJwk;
}

beforeAll(async () => {
  pg = await startPostgres();
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-f0512-booth-int', max: 12 });
  await migrateTicket(pg.url);
  const clock = fakeClock({ now: NOW });
  const gate = new DrizzleScannerGateStore(database);
  const deviceKeyStore = new DrizzleDeviceKeyStore({ database, changes: gate });
  ticketSvc = new TicketService({ store: new DrizzleTicketStore({ database, changes: gate, deviceKeys: deviceKeyStore }), clock });
  const issued = await ticketSvc.issue({ orderId: randomUUID(), eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [randomUUID()], issueGeneration: 0, eventStartsAtMs: NOW - 1 });
  ticketId = issued.tickets[0]!.ticketId;

  // 구현 뒤 생기는 저장소. 기준 트리에서는 불러오기가 실패해 아래 시험이 booth 없음으로 떨어진다.
  try {
    const path = '../src/modules/ticket/adapters/db/drizzle-booth-store.js';
    const mod = (await import(path)) as unknown as { DrizzleBoothStore: new (o: { database: Database }) => typeof booth };
    booth = new mod.DrizzleBoothStore({ database });
    keys = new DeviceKeys({ store: deviceKeyStore, clock, reauth: quiet, booth } as unknown as ConstructorParameters<typeof DeviceKeys>[0]); // type-escape: booth 옵션은 구현 뒤 생긴다
  } catch {
    booth = undefined as unknown as typeof booth;
    keys = new DeviceKeys({ store: deviceKeyStore, clock, reauth: quiet });
  }
});
afterAll(async () => {
  await database?.close().catch(() => {});
  pg?.stop();
});

describe('O-T28 ③ 실제 PostgreSQL BOOTH 등록 한 번', () => {
  test('O-T28 ③ 같은 부스 허용의 BOOTH 등록 20개가 동시에 와도 키 하나만 저장되고 사용 표시가 남는다', async () => {
    const created = (await booth.createRequest({ ticketId, accountId: ACCOUNT, codeHash: CODE_HASH, nowMs: NOW, dayKey: '2026-11-26', expiresAtMs: NOW + CODE_MS })) as { kind: string; boothRequestId: string };
    expect(created.kind).toBe('created');
    const allowed = (await booth.authorize({ eventId: EVENT, deviceId: DEVICE, codeHash: CODE_HASH, nowMs: NOW, allowUntilMs: NOW + CODE_MS })) as { kind: string; ticketId: string };
    expect(allowed).toEqual(expect.objectContaining({ kind: 'authorized', ticketId }));

    const jwks = await Promise.all(Array.from({ length: 20 }, () => publicJwk()));
    const results = await Promise.allSettled(jwks.map((publicKeyJwk) => keys.register({ ticketId, accountId: ACCOUNT, sessionId: randomUUID(), publicKeyJwk, reason: 'BOOTH', boothRequestId: created.boothRequestId })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(19);
    expect(rejected.every((r) => ['BOOTH_NOT_ALLOWED', 'REISSUE_AT_BOOTH'].includes((r.reason as { code?: string }).code ?? ''))).toBe(true);

    const keyRows = await database.pool.query<{ n: number }>('select count(*)::int n from device_key where ticket_id = $1 and revoked_at is null', [ticketId]);
    expect(keyRows.rows[0]!.n).toBe(1);
    const boothRows = await database.pool.query<{ used: boolean }>('select used_at is not null used from booth_authorization where id = $1', [created.boothRequestId]);
    expect(boothRows.rows[0]!.used).toBe(true);
  });
});
