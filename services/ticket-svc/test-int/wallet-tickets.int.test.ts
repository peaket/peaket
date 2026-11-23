// 월렛 목록 GET /v1/tickets 실제 PostgreSQL 통합 시험(FIX-wallet-tickets, docs/features/offline-gate.md §2 '월렛 목록 서버'·§11 O-T51).
// 시험 담당(fwal-test-2e9a)이 구현 전에 썼다(ADR-0372). 시험 조립이 아니라 시작 파일 start()를 실제 PostgreSQL 18로 띄우고(start.ts가 목록 처리기를
// 싣는지까지 본다, 계획 13절 '시작 파일 조립') 그 HTTP 포트로 부른다. 표는 같은 DB에 붙은 DrizzleTicketStore·DrizzleTransferStore 쓰임새로 만든다.
// - 실행마다 계정·회차를 새로 만든다(공유 DB에서 앞 시험의 표와 섞이지 않게, TA-V09).
// - 단언 값은 정본에서 옮겼다(칸 이름·상태·문제 종류 invalid-query·Cache-Control 값).
import * as grpc from '@grpc/grpc-js';
import { randomUUID } from 'node:crypto';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { Writable } from 'node:stream';
import { ListTicketsResponse } from '@peaket/contracts/openapi/tickets';
import { createDatabase, fakeClock, type Database, type FakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleDeviceKeyStore } from '../src/modules/ticket/adapters/db/drizzle-device-key-store.js';
import { DrizzleTicketStore } from '../src/modules/ticket/adapters/db/drizzle-ticket-store.js';
import { DrizzleTransferStore } from '../src/modules/ticket/adapters/db/drizzle-transfer-store.js';
import { DrizzleScannerGateStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-gate-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import type { IssueTicketsResult } from '../src/modules/ticket/domain/ticket.js';
import { ticketPackage } from '../src/modules/ticket/inbound/ticket.grpc.js';
import { start, type StartedService } from '../src/start.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-23T03:00:00.000Z');
const DAY = 24 * 3_600_000;
const STARTS = NOW + 7 * DAY;

let pg: PostgresContainer;
let database: Database;
let clock: FakeClock;
let tickets: TicketService;
let transfers: DrizzleTransferStore;
let svc: StartedService;
const logs: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-wallet-int', max: 4 });
  const changes = new DrizzleScannerGateStore(database);
  const deviceKeys = new DrizzleDeviceKeyStore({ database, changes });
  clock = fakeClock({ now: NOW });
  tickets = new TicketService({ store: new DrizzleTicketStore({ database, changes, deviceKeys }), clock });
  transfers = new DrizzleTransferStore({ database, deviceKeys });
  svc = await start({
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_DATABASE_URL: pg.url,
      PORT: String(await freePort()),
      PEAKET_MANAGEMENT_PORT: String(await freePort()),
      PEAKET_GRPC_PORT: '0',
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      // 정상 줄도 모두 남겨 기록 줄을 빠짐없이 본다
      PEAKET_LOG_SAMPLE_ONE_IN: '1',
    },
    logDestination: new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        logs.push(String(chunk));
        cb();
      },
    }),
  });
}, 180_000);

afterAll(async () => {
  await svc?.close().catch(() => {});
  await database?.close().catch(() => {});
  pg?.stop();
});

type Item = Record<string, unknown>;
interface Page {
  readonly status: number;
  readonly cacheControl: string | null;
  readonly raw: string;
  readonly body: { items?: Item[]; nextCursor?: string | null; type?: string; title?: string };
}

/** 게이트웨이가 넘기는 팬 머리로 start()의 HTTP 포트를 부른다 */
async function list(account: string, query = ''): Promise<Page> {
  const r = await fetch(`http://127.0.0.1:${svc.ports.appPort}/v1/tickets${query}`, {
    headers: { 'x-user-id': account, 'x-session-id': randomUUID(), 'x-user-aud': 'fan' },
  });
  const raw = await r.text();
  let body: Page['body'] = {};
  try {
    body = JSON.parse(raw) as Page['body'];
  } catch {
    body = {};
  }
  return { status: r.status, cacheControl: r.headers.get('cache-control'), raw, body };
}

const ids = (p: Page): string[] => (p.body.items ?? []).map((i) => String(i.ticketId));
const byIdDesc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);
const orderIds = (r: IssueTicketsResult): string[] => r.tickets.map((t) => t.ticketId).sort(byIdDesc);
const problemName = (p: Page): string => String(p.body.type ?? '').split('/').filter(Boolean).pop() ?? '';

/** 한 주문 발권 뒤 시계를 1초 민다 */
async function issue(account: string, eventId: string, seats = 1): Promise<IssueTicketsResult> {
  const r = await tickets.issue({ orderId: randomUUID(), eventId, payerAccountId: account, seatIds: Array.from({ length: seats }, () => randomUUID()), issueGeneration: 0, eventStartsAtMs: STARTS });
  clock.advance(1_000);
  return r;
}

async function transferTo(ticketId: string, from: string, to: string): Promise<void> {
  const offerId = randomUUID();
  const created = await transfers.createOffer({ offerId, ticketId, fromAccountId: from, toAccountId: to, status: 'OFFERED', expiresAtMs: clock.now() + 2 * DAY, createdAtMs: clock.now() }, clock.now());
  expect(created.kind).toBe('CREATED');
  expect((await transfers.accept({ offerId, accountId: to, nowMs: clock.now() })).kind).toBe('OK');
}

describe('월렛 목록 PostgreSQL [O-T51]', () => {
  test('O-T51 ① A 세션은 A가 보유한 표만 최신 발권순으로 받고 B의 표는 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const [a, b, event] = [randomUUID(), randomUUID(), randomUUID()];
    const a1 = await issue(a, event);
    const b1 = await issue(b, event);
    const a2 = await issue(a, event, 2);
    const p = await list(a);
    expect(p.status, p.raw).toBe(200);
    expect(ListTicketsResponse.safeParse(p.body).success, p.raw).toBe(true);
    expect(ids(p)).toEqual([...orderIds(a2), ...orderIds(a1)]);
    expect(p.body.nextCursor).toBeNull();
    expect(p.raw.includes(b1.tickets[0]!.ticketId)).toBe(false);
    expect(ids(await list(b))).toEqual(orderIds(b1));
  });

  test('O-T51 ② FWAL-ORDER ① limit 2로 5장(같은 발권 시각 두 장 포함)을 2·2·1로 겹침 없이 받고 마지막만 nextCursor가 null이다', async () => {
    const [a, event] = [randomUUID(), randomUUID()];
    const first = await issue(a, event);
    const pair = await issue(a, event, 2);
    const later = [await issue(a, event), await issue(a, event)];
    const expected = [...orderIds(later[1]!), ...orderIds(later[0]!), ...orderIds(pair), ...orderIds(first)];
    const pages: Page[] = [];
    let cursor: string | null | undefined;
    for (let i = 0; i < 5 && cursor !== null; i += 1) {
      const p = await list(a, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(p.status, p.raw).toBe(200);
      pages.push(p);
      cursor = p.body.nextCursor;
    }
    expect(pages.map((p) => ids(p).length)).toEqual([2, 2, 1]);
    expect(pages.flatMap(ids)).toEqual(expected);
    expect(pages.map((p) => p.body.nextCursor === null)).toEqual([false, false, true]);
  });

  test('O-T51 ③ limit 0·101은 400, 풀리지 않는 커서는 400 invalid-query, B의 표 자리 커서는 A의 표만 준다', async () => {
    const [a, b, event] = [randomUUID(), randomUUID(), randomUUID()];
    const a1 = await issue(a, event);
    await issue(b, event);
    const a2 = await issue(a, event);
    const b2 = await issue(b, event);
    await issue(a, event);
    expect((await list(a, '?limit=0')).status).toBe(400);
    expect((await list(a, '?limit=101')).status).toBe(400);
    const bad = await list(a, `?cursor=${encodeURIComponent(Buffer.from('[1,"x"]', 'utf8').toString('base64url'))}`);
    expect(bad.status, bad.raw).toBe(400);
    expect(problemName(bad)).toBe('invalid-query');
    expect(bad.body.items).toBeUndefined();
    const bPage = await list(b, '?limit=1');
    expect(ids(bPage)).toEqual(orderIds(b2));
    const p = await list(a, `?limit=10&cursor=${encodeURIComponent(String(bPage.body.nextCursor))}`);
    expect(p.status, p.raw).toBe(200);
    expect(ids(p)).toEqual([...orderIds(a2), ...orderIds(a1)]);
  });

  test('O-T51 ④ 예매 취소(환급)한 표와 발권 막기(무효)한 표가 그 상태로 목록에 남는다', async () => {
    const [a, event] = [randomUUID(), randomUUID()];
    const refunded = await issue(a, event);
    const voided = await issue(a, event);
    const live = await issue(a, event);
    const out = await tickets.cancel({ orderId: refunded.tickets[0]!.orderId, ticketIds: [refunded.tickets[0]!.ticketId], requestedByAccountId: a, cancellationId: randomUUID(), nowMs: clock.now() });
    expect(out.map((x) => x.result)).toEqual(['REFUND_NOW']);
    expect(await tickets.blockIssue({ orderId: voided.tickets[0]!.orderId, reason: 'FWAL 통합 시험' })).toMatchObject({ voided: 1 });
    const p = await list(a);
    expect((p.body.items ?? []).map((i) => [i.ticketId, i.status])).toEqual([
      [live.tickets[0]!.ticketId, 'ISSUED'],
      [voided.tickets[0]!.ticketId, 'VOIDED'],
      [refunded.tickets[0]!.ticketId, 'REFUNDED'],
    ]);
  });

  test('O-T51 ⑤ 항목은 계약 칸만이고 구역·회차 시작은 ticket 데이터 값이다 [ASVS v5.0.0-15.3.1]', async () => {
    const [a, event] = [randomUUID(), randomUUID()];
    const plain = await issue(a, event);
    const zoned = await issue(a, event);
    await database.pool.query("update ticket set gate_zone = 'C' where id = $1", [zoned.tickets[0]!.ticketId]);
    const noStart = await tickets.issue({ orderId: randomUUID(), eventId: event, payerAccountId: a, seatIds: [randomUUID()], issueGeneration: 0 });
    clock.advance(1_000);
    const p = await list(a);
    expect(p.status, p.raw).toBe(200);
    const byId = new Map((p.body.items ?? []).map((i) => [String(i.ticketId), i]));
    const z = byId.get(zoned.tickets[0]!.ticketId)!;
    expect(Object.keys(z).sort()).toEqual(['cancelDeadline', 'eventId', 'eventStartsAt', 'gateZone', 'pendingTransfer', 'receivedFromNickname', 'status', 'ticketId', 'transferLocked']);
    expect(z).toMatchObject({ eventId: event, status: 'ISSUED', gateZone: 'C', transferLocked: false, receivedFromNickname: null });
    expect(Date.parse(String(z.eventStartsAt))).toBe(STARTS);
    expect(z.cancelDeadline).toBe(z.eventStartsAt);
    expect(Object.keys(byId.get(plain.tickets[0]!.ticketId)!).sort()).toEqual(['cancelDeadline', 'eventId', 'eventStartsAt', 'pendingTransfer', 'receivedFromNickname', 'status', 'ticketId', 'transferLocked']);
    expect(Object.keys(byId.get(noStart.tickets[0]!.ticketId)!).sort()).toEqual(['eventId', 'pendingTransfer', 'receivedFromNickname', 'status', 'ticketId', 'transferLocked']);
    for (const r of [plain, zoned, noStart]) {
      for (const t of r.tickets) {
        for (const v of [t.orderId, t.seatId, t.keyHash, String(t.ticketKey), t.qrPayload]) expect(p.raw.includes(v), `응답에 계약 밖 값 ${v.slice(0, 12)}…`).toBe(false);
      }
    }
    expect(p.raw.includes(a)).toBe(false);
    expect(p.raw.includes('PEAKET1:')).toBe(false);
  });

  test('O-T51 ⑦ 양도 수락 뒤 그 표는 B의 목록에만 있고 받은 표에는 receivedFromNickname 칸이 없다', async () => {
    const [a, b, event] = [randomUUID(), randomUUID(), randomUUID()];
    const kept = await issue(a, event);
    const given = await issue(a, event);
    await transferTo(given.tickets[0]!.ticketId, a, b);
    expect(ids(await list(a))).toEqual(orderIds(kept));
    const pb = await list(b);
    expect(ids(pb)).toEqual(orderIds(given));
    expect(pb.body.items![0]!.status).toBe('ACTIVE');
    expect('receivedFromNickname' in pb.body.items![0]!).toBe(false);
  });

  test('O-T51 ⑧ 실제 서버의 200·400 모두 private, no-store이고 기록 줄에 티켓 키·PEAKET1 값이 없다 [ASVS v5.0.0-14.2.2] [ASVS v5.0.0-14.3.2] [ASVS v5.0.0-16.2.5]', async () => {
    const [a, event] = [randomUUID(), randomUUID()];
    const r = await issue(a, event, 2);
    const ok = await list(a, '?limit=1');
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.cacheControl).toBe('private, no-store');
    const bad = await list(a, '?cursor=%25%25');
    expect(bad.status).toBe(400);
    expect(bad.cacheControl).toBe('private, no-store');
    const text = logs.join('');
    expect(text.includes('/v1/tickets'), '목록 요청의 기록 줄이 없다(빈 기록으로 통과하지 않게)').toBe(true);
    for (const t of r.tickets) {
      expect(text.includes(String(t.ticketKey)), '기록에 티켓 키').toBe(false);
      expect(text.includes(t.keyHash), '기록에 키 해시').toBe(false);
    }
    expect(text.includes('PEAKET1:')).toBe(false);
  });

  test('FWAL-GRPC ① 풀리지 않는 커서는 gRPC ListTickets에서도 INVALID_ARGUMENT다', async () => {
    const Ctor = ticketPackage().TicketService;
    const client = new Ctor(`127.0.0.1:${svc.ports.grpcPort}`, grpc.credentials.createInsecure());
    try {
      const err = await new Promise<grpc.ServiceError | null>((resolve) => {
        client.ListTickets({ account_id: randomUUID(), cursor: Buffer.from('[1]', 'utf8').toString('base64url'), limit: 10 }, (e: grpc.ServiceError | null) => resolve(e));
      });
      expect(err?.code).toBe(grpc.status.INVALID_ARGUMENT);
    } finally {
      client.close();
    }
  });
});
