// 양도·돌려주기 HTTP 시험(BUILD_ORDER GAT-050·GAT-055, openapi `/v1/tickets/{ticketId}/transfers`·`/v1/transfers/*`·`/v1/tickets/{ticketId}/returns`).
// 팬 쿠키 머리로 201·200·400·404·409를 보고, 남의 요청·다른 계정의 수락이 같은 404인지(8.2.2), 멱등 키가 없으면 400인지(R-T21 ②) 본다.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { createService, fakeClock, MemoryDpopReplayStore, type AdminAuthzPort, type ScannerSessionCheck } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { MemoryDeviceKeyStore } from '../src/modules/ticket/adapters/memory-device-key-store.js';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { MemoryTransferStore } from '../src/modules/ticket/adapters/memory-transfer-store.js';
import { Transfers } from '../src/modules/ticket/application/transfers.js';
import { DeviceKeys } from '../src/modules/ticket/application/device-keys.js';
import { signRecipientRef } from '../src/modules/ticket/domain/transfer.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const EVENT = '0193f2c0-0000-7000-8000-0000000000e1';
const PAYER = '0193f2c0-0000-7000-8000-0000000000a1';
const FRIEND = '0193f2c0-0000-7000-8000-0000000000b2';
const OTHER = '0193f2c0-0000-7000-8000-0000000000c3';
const TICKET = '0193f2c0-0000-7000-8000-000000000001';
const SESSION = '0193f2c0-0000-7000-8000-0000000000b1';
const SECRET = 'test-secret';
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

/** 멱등 키는 플랫폼이 UUID v4만 받는다(docs/api/guidelines.md §4) */
const KEY = (n: number): string => `0193f2c0-0000-4000-8000-00000000000${n}`;

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

let svc: Awaited<ReturnType<typeof createService>>;
let tickets: MemoryTicketStore;
let clock: ReturnType<typeof fakeClock>;

const fan = (account: string) => ({ 'x-user-id': account, 'x-session-id': SESSION, 'x-user-aud': 'fan', 'content-type': 'application/json' });
const ref = (accountId: string) => signRecipientRef({ secret: SECRET, accountId, expiresAtMs: NOW + 10 * 60_000 });
const post = (url: string, account: string, body: unknown, key?: string, extra: Record<string, string> = {}) =>
  svc.http.inject({
    method: 'POST',
    url,
    headers: { ...fan(account), ...(key === undefined ? {} : { 'idempotency-key': key }), ...extra },
    payload: JSON.stringify(body),
  });
const get = (url: string, account: string) => svc.http.inject({ method: 'GET', url, headers: { ...fan(account) } });

beforeAll(async () => {
  clock = fakeClock({ now: NOW });
  tickets = new MemoryTicketStore();
  const store = new MemoryTransferStore({ tickets });
  const transfers = new Transfers({
    store,
    reauth: { verify: async () => true },
    recipientRefSecret: SECRET,
    clock,
    directory: { resolveMemberCode: async (code) => (code === 'ABC-1234' ? { accountId: FRIEND, nickname: 'friend' } : undefined) },
  });
  const deviceKeysStore = new MemoryDeviceKeyStore();
  deviceKeysStore.seedTicket({ ticketId: TICKET, eventId: EVENT, accountId: PAYER });
  const gate = new MemoryScannerGateStore(deviceKeysStore);
  const shift = new MemoryScannerShiftStore(gate);
  const devices = new MemoryScannerDeviceStore();
  svc = await createService({
    name: 'ticket-svc-transfers-http',
    module: AppModule.register({
      scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay: new MemoryDpopReplayStore(clock), gate, shift },
      ticket: { deviceKeys: new DeviceKeys({ store: deviceKeysStore, clock }), transfers },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: new FakeAdmin(),
    scanner: { devices, sessions: new FakeSessions(), replay: new MemoryDpopReplayStore(clock) },
  });
  await tickets.issue(
    {
      orderId: '0193f2c0-0000-7000-8000-0000000000d1',
      eventId: EVENT,
      payerAccountId: PAYER,
      seatIds: ['0193f2c0-0000-7000-8000-0000000000c1'],
      issueGeneration: 0,
      eventStartsAtMs: NOW + 72 * HOUR,
      fingerprint: 'f1',
      nowMs: NOW,
    },
    [
      {
        ticketId: TICKET,
        accountId: PAYER,
        payerAccountId: PAYER,
        orderId: '0193f2c0-0000-7000-8000-0000000000d1',
        eventId: EVENT,
        seatId: '0193f2c0-0000-7000-8000-0000000000c1',
        gateZone: '',
        status: 'ACTIVE',
        issueGeneration: 0,
        qrPayload: 'PEAKET1:x',
        keyHash: 'a'.repeat(64),
        transferPending: false,
        version: 0,
        issuedAtMs: NOW,
        eventStartsAtMs: NOW + 72 * HOUR,
      },
    ],
  );
});

afterAll(async () => {
  await svc?.close().catch(() => {});
});

describe('양도 HTTP', () => {
  test('R-T21 ② Idempotency-Key가 없거나 형식이 틀리면 400 idempotency-key-invalid이고 요청을 만들지 않는다', async () => {
    const r = await post(`/v1/tickets/${TICKET}/transfers`, PAYER, { recipientRef: ref(FRIEND) }, 'not-a-uuid', { 'x-reauth-token': 'r' });
    expect(r.statusCode).toBe(400);
    expect((JSON.parse(r.payload) as { type: string }).type).toContain('idempotency-key-invalid');
    expect(tickets.tickets.get(TICKET)?.transferPending).toBe(false);
  });

  test('R-T2 받은 사람이 다시 양도하면 409이고, 결제자가 아니면 404다', async () => {
    const first = await post(`/v1/tickets/${TICKET}/transfers`, PAYER, { recipientRef: ref(FRIEND) }, KEY(1), { 'x-reauth-token': 'r' });
    expect(first.statusCode).toBe(201);
    const offerId = (JSON.parse(first.payload) as { offerId: string }).offerId;
    expect((await post(`/v1/transfers/${offerId}/acceptance`, FRIEND, {}, KEY(2))).statusCode).toBe(200);
    const again = await post(`/v1/tickets/${TICKET}/transfers`, FRIEND, { recipientRef: ref(OTHER) }, KEY(3), { 'x-reauth-token': 'r' });
    expect(again.statusCode).toBe(409);
    expect((JSON.parse(again.payload) as { type: string }).type).toContain('reoffer-not-allowed');
  });

  test('R-T17 입장이 시작된 표는 양도·돌려주기가 409 entry-started다', async () => {
    tickets.tickets.set(TICKET, { ...tickets.tickets.get(TICKET)!, accountId: PAYER, eventStartsAtMs: NOW - 1, transferPending: false, status: 'ACTIVE' });
    const r = await post(`/v1/tickets/${TICKET}/transfers`, PAYER, { recipientRef: ref(FRIEND) }, KEY(4), { 'x-reauth-token': 'r' });
    expect(r.statusCode).toBe(409);
    expect((JSON.parse(r.payload) as { type: string }).type).toContain('entry-started');
  });

  test('[ASVS v5.0.0-8.2.2] 양도 요청 조회·수락은 보낸 사람·받는 사람만 한다(남의 요청은 같은 404)', async () => {
    tickets.tickets.set(TICKET, { ...tickets.tickets.get(TICKET)!, accountId: PAYER, eventStartsAtMs: NOW + 72 * HOUR, transferPending: false, status: 'ACTIVE' });
    const created = await post(`/v1/tickets/${TICKET}/transfers`, PAYER, { recipientRef: ref(FRIEND) }, KEY(5), { 'x-reauth-token': 'r' });
    expect(created.statusCode).toBe(201);
    const offerId = (JSON.parse(created.payload) as { offerId: string }).offerId;
    expect((await get(`/v1/transfers/${offerId}`, PAYER)).statusCode).toBe(200);
    expect((await get(`/v1/transfers/${offerId}`, FRIEND)).statusCode).toBe(200);
    expect((await get(`/v1/transfers/${offerId}`, OTHER)).statusCode).toBe(404);
    expect((await post(`/v1/transfers/${offerId}/acceptance`, OTHER, {}, KEY(6))).statusCode).toBe(404);
  });
});

describe('받는 사람 찾기 HTTP', () => {
  test('회원 코드로 찾으면 200과 10분 참조를 주고, 없는 코드는 404다', async () => {
    const ok = await post('/v1/transfer-recipient-lookups', PAYER, { memberCode: 'abc-1234' });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toMatchObject({ nicknameMasked: 'f***' });
    expect((JSON.parse(ok.payload) as { recipientRef: string }).recipientRef).toContain('.');
    expect((await post('/v1/transfer-recipient-lookups', PAYER, { memberCode: 'XYZ-9999' })).statusCode).toBe(404);
  });
});
