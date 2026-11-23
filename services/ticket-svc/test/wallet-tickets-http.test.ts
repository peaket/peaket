// 월렛 목록 HTTP 시험(FIX-wallet-tickets, docs/features/offline-gate.md §2 '월렛 목록 서버'·§11 O-T47, openapi listTickets, docs/api/guidelines.md §3).
// 시험 담당(fwal-test-2e9a)이 구현 전에 썼다(ADR-0372). 계획 docs/review/plans/FIX-wallet-tickets.md §8.1·§8.2 모양 그대로다.
// - 진짜: 처리기·TicketService·플랫폼 계약 검사. 바꿔 끼운 것은 저장소 포트(MemoryTicketStore·MemoryTransferStore, 포트를 implements한 짝 가짜)와 시계(fakeClock)뿐이다.
//   같은 동작을 실제 PostgreSQL로 덮는 시험은 test-int/wallet-tickets.int.test.ts다.
// - 표는 쓰임새(issue·cancel·blockIssue·양도 저장소)로 만든다. 그 쓰임새가 이 서비스에 없는 상태(CANCEL_REQUESTED·FLAGGED)와 게이트 구역만
//   메모리 저장소 기록을 시험 씨앗으로 고친다(발권은 늘 빈 구역이고, 좌석 배치 연결은 후속이다).
// - 단언 값(칸 이름·상태·400 문제 종류·머리 값·기본 20 [가정]·최대 100)은 정본에서 옮겼고 코드 상수를 가져오지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { ListTicketsResponse } from '@peaket/contracts/openapi/tickets';
import { createService, fakeClock, type FakeClock, MemoryDpopReplayStore, type AdminAuthzPort, type ScannerSessionCheck } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { MemoryDeviceKeyStore } from '../src/modules/ticket/adapters/memory-device-key-store.js';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { MemoryTransferStore } from '../src/modules/ticket/adapters/memory-transfer-store.js';
import { DeviceKeys } from '../src/modules/ticket/application/device-keys.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import type { TicketStore } from '../src/modules/ticket/domain/ports.js';
import { type IssueTicketsResult, type ListTicketsInput, type ListTicketsResult, type TicketRecord, type TicketStatus, TicketInputError } from '../src/modules/ticket/domain/ticket.js';

const NOW = Date.parse('2026-11-23T03:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 회차 시작: 7일 뒤(양도·취소가 열려 있는 때) */
const STARTS = NOW + 7 * DAY;
const A = '0193f2c0-0000-7000-8000-00000000a001';
const B = '0193f2c0-0000-7000-8000-00000000b002';
const SESSION = '0193f2c0-0000-7000-8000-00000000c003';
const EVENT = '0193f2c0-0000-7000-8000-00000000e001';
const OTHER_EVENT = '0193f2c0-0000-7000-8000-00000000e002';

/** 정본 offline-gate §2 '무엇을 싣나'의 계약 칸 가운데 ticket 데이터로 채우는 것(이 밖의 칸은 없어야 한다) */
const ALLOWED_KEYS = ['ticketId', 'eventId', 'status', 'transferLocked', 'gateZone', 'eventStartsAt', 'cancelDeadline', 'receivedFromNickname'];

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

/** 목록 읽기가 실패하는 저장소(장애 주입: DB 연결이 끊긴 자리). 나머지는 진짜 메모리 저장소에 맡긴다 */
class BrokenListStore extends MemoryTicketStore implements TicketStore {
  override async list(_input: ListTicketsInput): Promise<ListTicketsResult> {
    throw new Error('connect ECONNREFUSED 10.0.0.9:5432');
  }
}

type Item = Record<string, unknown>;
interface Page {
  readonly status: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly raw: string;
  readonly body: { items?: Item[]; nextCursor?: string | null; type?: string; title?: string };
}

interface Who {
  readonly account?: string;
  readonly session?: string;
  readonly aud?: string;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => {});
});

/** 시험마다 새 서비스·저장소·시계(TA-V01). logs는 그 서비스의 기록 줄(문자열) */
async function harness(o: { store?: MemoryTicketStore } = {}) {
  const clock: FakeClock = fakeClock({ now: NOW });
  const store = o.store ?? new MemoryTicketStore();
  const transfers = new MemoryTransferStore({ tickets: store });
  const tickets = new TicketService({ store, clock });
  const logs: string[] = [];
  const sink = new Writable({
    write: (chunk: Buffer | string, _enc, cb) => {
      logs.push(String(chunk));
      cb();
    },
  });
  const replay = new MemoryDpopReplayStore(clock);
  const deviceKeysStore = new MemoryDeviceKeyStore();
  const gate = new MemoryScannerGateStore(deviceKeysStore);
  const shift = new MemoryScannerShiftStore(gate);
  const devices = new MemoryScannerDeviceStore();
  const svc = await createService({
    name: 'ticket-svc-wallet-tickets-http',
    module: AppModule.register({
      scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay, gate, shift },
      ticket: { deviceKeys: new DeviceKeys({ store: deviceKeysStore, clock }), tickets },
    }),
    // 정상 줄도 모두 남겨(표본 1건에 1건) 기록 줄을 빠짐없이 본다
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' },
    clock,
    logDestination: sink,
    adminAuthz: new FakeAdmin(),
    scanner: { devices, sessions: new FakeSessions(), replay },
  });
  closers.push(() => svc.close());

  const get = async (query = '', who: Who = {}): Promise<Page> => {
    const headers: Record<string, string> = {};
    if (who.account !== '') headers['x-user-id'] = who.account ?? A;
    if (who.session !== '') headers['x-session-id'] = who.session ?? SESSION;
    if (who.aud !== '') headers['x-user-aud'] = who.aud ?? 'fan';
    const r = await svc.http.inject({ method: 'GET', url: `/v1/tickets${query}`, headers });
    let body: Page['body'] = {};
    try {
      body = JSON.parse(r.payload) as Page['body'];
    } catch {
      body = {};
    }
    return { status: r.statusCode, headers: r.headers, raw: r.payload, body };
  };

  /** 한 주문을 발권하고 시계를 1초 민다(다음 발권은 더 늦은 발권 시각) */
  const issue = async (account: string, o2: { seats?: number; eventId?: string; startsAtMs?: number | null } = {}): Promise<IssueTicketsResult> => {
    const seatIds = Array.from({ length: o2.seats ?? 1 }, () => randomUUID());
    const r = await tickets.issue({
      orderId: randomUUID(),
      eventId: o2.eventId ?? EVENT,
      payerAccountId: account,
      seatIds,
      issueGeneration: 0,
      ...(o2.startsAtMs === null ? {} : { eventStartsAtMs: o2.startsAtMs ?? STARTS }),
    });
    clock.advance(1_000);
    return r;
  };

  /** 메모리 저장소 기록을 시험 씨앗으로 고친다(쓰임새가 없는 상태·게이트 구역) */
  const seed = (ticketId: string, patch: Partial<Pick<TicketRecord, 'status' | 'gateZone'>>): void => {
    const t = store.tickets.get(ticketId);
    if (!t) throw new Error(`씨앗: 없는 표 ${ticketId}`);
    store.tickets.set(ticketId, { ...t, ...patch });
  };

  return { svc, clock, store, transfers, tickets, logs, get, issue, seed };
}

const idsOf = (p: Page): string[] => (p.body.items ?? []).map((i) => String(i.ticketId));
const byIdDesc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);
/** 한 주문의 표들: 같은 발권 시각이라 티켓 ID 내림차순(정본 '차례와 나누기') */
const orderTicketIds = (r: IssueTicketsResult): string[] => r.tickets.map((t) => t.ticketId).sort(byIdDesc);
const problemName = (p: Page): string => String(p.body.type ?? '').split('/').filter(Boolean).pop() ?? '';

/** 커서를 끝까지 따라 모든 쪽을 받는다(쪽이 10을 넘으면 멈춘다: 끝나지 않는 커서는 실패) */
async function allPages(get: (q?: string, w?: Who) => Promise<Page>, limit: number, who: Who = {}): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null | undefined;
  for (let i = 0; i < 10; i += 1) {
    const q = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const p = await get(q, who);
    expect(p.status, `쪽 ${i + 1} ${p.raw.slice(0, 200)}`).toBe(200);
    pages.push(p);
    cursor = p.body.nextCursor;
    if (cursor === null) return pages;
    expect(typeof cursor, `쪽 ${i + 1}의 nextCursor는 문자열이거나 null이다`).toBe('string');
  }
  throw new Error('nextCursor가 10쪽이 지나도 null이 되지 않았다');
}

describe('월렛 목록 GET /v1/tickets [O-T47]', () => {
  test('O-T47 ① A 세션은 A가 보유한 표만 최신 발권순으로 받고 B의 표는 없다(ASVS v5.0.0-8.2.2)', async () => {
    const h = await harness();
    const a1 = await h.issue(A);
    const b1 = await h.issue(B);
    const a2 = await h.issue(A, { seats: 2 });
    const b2 = await h.issue(B);
    const a3 = await h.issue(A, { eventId: OTHER_EVENT });

    const p = await h.get('');
    expect(p.status, p.raw).toBe(200);
    expect(String(p.headers['content-type'] ?? '')).toMatch(/^application\/json/);
    // 계약 Zod를 지난다(openapi ListTicketsResponse)
    expect(ListTicketsResponse.safeParse(p.body).success, p.raw).toBe(true);
    // 최신 발권순, 같은 주문(같은 발권 시각) 두 장은 티켓 ID 내림차순
    expect(idsOf(p)).toEqual([...orderTicketIds(a3), ...orderTicketIds(a2), ...orderTicketIds(a1)]);
    expect(p.body.nextCursor).toBeNull();
    const bIds = [...orderTicketIds(b1), ...orderTicketIds(b2)];
    for (const id of bIds) expect(p.raw.includes(id), `B의 표 ${id}가 A 목록에 있다`).toBe(false);

    // B 세션은 B의 표만
    const pb = await h.get('', { account: B });
    expect(idsOf(pb)).toEqual([...orderTicketIds(b2), ...orderTicketIds(b1)]);
  });

  test('FWAL-ORDER ① 같은 발권 시각의 표는 티켓 ID 내림차순이고 limit 1로 나눠도 그 차례다', async () => {
    const h = await harness();
    const r = await h.issue(A, { seats: 3 });
    const expected = orderTicketIds(r);
    const pages = await allPages(h.get, 1);
    expect(pages.map(idsOf)).toEqual(expected.map((id) => [id]));
  });

  test('O-T47 ② limit 2로 5장을 2·2·1로 겹침 없이 받고 마지막만 nextCursor가 null이다', async () => {
    const h = await harness();
    const issued: string[][] = [];
    for (let i = 0; i < 5; i += 1) issued.push(orderTicketIds(await h.issue(A)));
    const expected = issued.reverse().flat();
    await h.issue(B);

    const pages = await allPages(h.get, 2);
    expect(pages.map((p) => idsOf(p).length)).toEqual([2, 2, 1]);
    expect(pages.flatMap(idsOf)).toEqual(expected);
    expect(new Set(pages.flatMap(idsOf)).size).toBe(5);
    expect(pages.map((p) => p.body.nextCursor === null)).toEqual([false, false, true]);
    for (const p of pages.slice(0, 2)) expect(String(p.body.nextCursor).length, '빈 글 커서').toBeGreaterThan(0);
  });

  test('O-T47 ② 경계: 정확히 4장을 limit 2로 받으면 2·2이고 둘째 쪽에서 nextCursor가 null이다(빈 셋째 쪽 없음)', async () => {
    const h = await harness();
    const expected: string[] = [];
    for (let i = 0; i < 4; i += 1) expected.unshift(...orderTicketIds(await h.issue(A)));
    const pages = await allPages(h.get, 2);
    expect(pages.map((p) => idsOf(p).length)).toEqual([2, 2]);
    expect(pages.flatMap(idsOf)).toEqual(expected);
    expect(pages[1]!.body.nextCursor).toBeNull();
  });

  test('O-T47 ② 경계: 표가 0장이면 빈 목록과 nextCursor null이다', async () => {
    const h = await harness();
    await h.issue(B);
    const p = await h.get('?limit=100');
    expect(p.status, p.raw).toBe(200);
    expect(p.body).toEqual({ items: [], nextCursor: null });
  });

  test('O-T47 ③ limit을 빼면 20장 [가정]까지, limit 1·100은 된다', async () => {
    const h = await harness();
    const expected: string[] = [];
    for (let i = 0; i < 21; i += 1) expected.unshift(...orderTicketIds(await h.issue(A)));
    const first = await h.get('');
    expect(first.status, first.raw).toBe(200);
    expect(idsOf(first)).toEqual(expected.slice(0, 20));
    expect(typeof first.body.nextCursor).toBe('string');
    const rest = await h.get(`?cursor=${encodeURIComponent(String(first.body.nextCursor))}`);
    expect(idsOf(rest)).toEqual(expected.slice(20));
    expect(rest.body.nextCursor).toBeNull();

    const one = await h.get('?limit=1');
    expect(one.status, one.raw).toBe(200);
    expect(idsOf(one)).toEqual(expected.slice(0, 1));
    const hundred = await h.get('?limit=100');
    expect(hundred.status, hundred.raw).toBe(200);
    expect(idsOf(hundred)).toEqual(expected);
    expect(hundred.body.nextCursor).toBeNull();
  });

  test('O-T47 ③ limit 0·101·정수 아님·같은 쿼리 두 번은 400이다(101을 100으로 잘라 받지 않는다)', async () => {
    const h = await harness();
    await h.issue(A);
    for (const q of ['?limit=0', '?limit=101', '?limit=-1', '?limit=2.5', '?limit=abc', '?limit=2&limit=3']) {
      const p = await h.get(q);
      expect(p.status, `${q} ${p.raw.slice(0, 200)}`).toBe(400);
      expect(p.body.items, `${q}에 목록이 실렸다`).toBeUndefined();
    }
  });

  test('O-T47 ③ 풀리지 않는 커서는 처음 쪽으로 보지 않고 400 invalid-query다', async () => {
    const h = await harness();
    await h.issue(A);
    await h.issue(A);
    const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
    for (const [label, cursor] of [
      ['base64url 아님', '%%%이건-커서가-아니다'],
      ['JSON 아님', Buffer.from('not json', 'utf8').toString('base64url')],
      ['배열 아님', b64({ issuedAtMs: NOW, ticketId: A })],
      ['칸 수 다름', b64([NOW])],
      ['티켓 자리가 UUID 아님', b64([NOW, 'tkt-1'])],
      ['시각 자리가 수 아님', b64(['어제', randomUUID()])],
    ] as const) {
      const p = await h.get(`?limit=10&cursor=${encodeURIComponent(cursor)}`);
      expect(p.status, `${label} ${p.raw.slice(0, 200)}`).toBe(400);
      expect(problemName(p), label).toBe('invalid-query');
      expect(p.body.title, label).toBe('목록 조건이 올바르지 않습니다');
      expect(p.body.items, `${label}: 처음 쪽을 줬다`).toBeUndefined();
    }
  });

  test('O-T47 ③ B의 표 자리로 만든 커서를 A 세션에 넣으면 그 자리보다 오래된 A의 표만 온다(ASVS v5.0.0-8.2.2)', async () => {
    const h = await harness();
    const a1 = await h.issue(A);
    const b1 = await h.issue(B);
    const a2 = await h.issue(A);
    const b2 = await h.issue(B);
    await h.issue(A);
    await h.issue(A);
    // B 목록 첫 쪽(limit 1)의 커서는 B2 자리다
    const bPage = await h.get('?limit=1', { account: B });
    expect(idsOf(bPage)).toEqual(orderTicketIds(b2));
    const bCursor = String(bPage.body.nextCursor);
    const p = await h.get(`?limit=10&cursor=${encodeURIComponent(bCursor)}`);
    expect(p.status, p.raw).toBe(200);
    expect(idsOf(p)).toEqual([...orderTicketIds(a2), ...orderTicketIds(a1)]);
    for (const id of orderTicketIds(b1)) expect(p.raw.includes(id), `B의 표 ${id}가 A 목록에 있다`).toBe(false);
  });

  test('O-T47 ④ 환급·무효 표가 그 상태로 목록에 남는다', async () => {
    const h = await harness();
    const refunded = await h.issue(A);
    const voided = await h.issue(A);
    const live = await h.issue(A);
    const outcome = await h.tickets.cancel({
      orderId: refunded.tickets[0]!.orderId,
      ticketIds: [refunded.tickets[0]!.ticketId],
      requestedByAccountId: A,
      cancellationId: randomUUID(),
      nowMs: h.clock.now(),
    });
    expect(outcome.map((x) => x.result)).toEqual(['REFUND_NOW']);
    expect(await h.tickets.blockIssue({ orderId: voided.tickets[0]!.orderId, reason: 'FWAL 시험' })).toMatchObject({ voided: 1 });

    const p = await h.get('');
    const status = new Map((p.body.items ?? []).map((i) => [i.ticketId, i.status]));
    expect(Object.fromEntries(status)).toEqual({
      [live.tickets[0]!.ticketId]: 'ISSUED',
      [voided.tickets[0]!.ticketId]: 'VOIDED',
      [refunded.tickets[0]!.ticketId]: 'REFUNDED',
    });
  });

  test('O-T47 ④ 취소 접수·확인 중·양도 요청 중 표도 그 상태로 남는다(ISSUED·ACTIVE만 거르지 않는다)', async () => {
    const h = await harness();
    const cancelReq = await h.issue(A);
    const flagged = await h.issue(A);
    const pending = await h.issue(A);
    h.seed(cancelReq.tickets[0]!.ticketId, { status: 'CANCEL_REQUESTED' });
    h.seed(flagged.tickets[0]!.ticketId, { status: 'FLAGGED' });
    const offer = await h.transfers.createOffer(
      { offerId: randomUUID(), ticketId: pending.tickets[0]!.ticketId, fromAccountId: A, toAccountId: B, status: 'OFFERED', expiresAtMs: NOW + 2 * DAY, createdAtMs: NOW },
      h.clock.now(),
    );
    expect(offer.kind).toBe('CREATED');
    const p = await h.get('');
    const expected: Record<string, TicketStatus> = {
      [pending.tickets[0]!.ticketId]: 'TRANSFER_PENDING',
      [flagged.tickets[0]!.ticketId]: 'FLAGGED',
      [cancelReq.tickets[0]!.ticketId]: 'CANCEL_REQUESTED',
    };
    expect(Object.fromEntries((p.body.items ?? []).map((i) => [i.ticketId, i.status]))).toEqual(expected);
    // 양도 요청 중인 표는 아직 A가 보유자다(B 목록에 없다)
    expect(idsOf(await h.get('', { account: B }))).toEqual([]);
  });

  test('O-T47 ⑤ 항목은 계약 칸만이고 주문·좌석·계정 ID·PEAKET1 포인터·티켓 키가 없다(ASVS v5.0.0-15.3.1)', async () => {
    const h = await harness();
    const withStart = await h.issue(A);
    const noStart = await h.issue(A, { startsAtMs: null });
    const zoned = await h.issue(A);
    h.seed(zoned.tickets[0]!.ticketId, { gateZone: 'B' });
    const p = await h.get('');
    expect(p.status, p.raw).toBe(200);
    const byId = new Map((p.body.items ?? []).map((i) => [String(i.ticketId), i]));

    // 결제자가 보유한 표, 회차 시작 있음, 빈 구역: 구역 칸 없음, 회차 시작 = 취소 기한, receivedFromNickname은 null
    const w = byId.get(withStart.tickets[0]!.ticketId)!;
    expect(Object.keys(w).sort()).toEqual(['cancelDeadline', 'eventId', 'eventStartsAt', 'receivedFromNickname', 'status', 'ticketId', 'transferLocked']);
    expect(w).toMatchObject({ ticketId: withStart.tickets[0]!.ticketId, eventId: EVENT, status: 'ISSUED', transferLocked: false, receivedFromNickname: null });
    expect(Date.parse(String(w.eventStartsAt))).toBe(STARTS);
    expect(w.cancelDeadline).toBe(w.eventStartsAt);

    // 회차 시작이 없는 발권: 두 칸 모두 없다(지금 시각 등 거짓 값을 채우지 않는다)
    const n = byId.get(noStart.tickets[0]!.ticketId)!;
    expect(Object.keys(n).sort()).toEqual(['eventId', 'receivedFromNickname', 'status', 'ticketId', 'transferLocked']);

    // 비지 않은 구역은 그대로
    const z = byId.get(zoned.tickets[0]!.ticketId)!;
    expect(z.gateZone).toBe('B');
    expect(Object.keys(z).sort()).toEqual(['cancelDeadline', 'eventId', 'eventStartsAt', 'gateZone', 'receivedFromNickname', 'status', 'ticketId', 'transferLocked']);

    for (const item of byId.values()) for (const k of Object.keys(item)) expect(ALLOWED_KEYS, `계약 밖 칸 ${k}`).toContain(k);
    // 응답 글 어디에도 계약 밖 값이 없다
    for (const r of [withStart, noStart, zoned]) {
      for (const t of r.tickets) {
        for (const [label, v] of [
          ['주문 ID', t.orderId],
          ['좌석 ID', t.seatId],
          ['키 해시', t.keyHash],
          ['티켓 키', t.ticketKey],
          ['QR 포인터', t.qrPayload],
        ] as const) {
          expect(typeof v === 'string' && v.length > 0, `${label} 시험 값이 비었다`).toBe(true);
          expect(p.raw.includes(String(v)), `응답에 ${label}가 있다`).toBe(false);
        }
      }
    }
    expect(p.raw.includes('PEAKET1:')).toBe(false);
    expect(p.raw.includes(A), '응답에 계정 ID가 있다').toBe(false);
    // ticket 데이터에 없는 칸은 빠져 있다(빈 글·null로 채우지 않는다)
    for (const k of ['seatLabel', 'eventTitle', 'placeName', 'entryOpensAt', 'transferable', 'transferDeadline', 'bookingNumber', 'enteredAt', 'transferLockExpiresAt', 'seller']) {
      expect(p.raw.includes(`"${k}"`), `칸 ${k}가 있다`).toBe(false);
    }
  });

  test('O-T47 ⑤ 받은 표는 receivedFromNickname 칸이 없고 부정 예매 양도 잠금이 걸린 표는 transferLocked가 true다', async () => {
    const h = await harness();
    const given = await h.issue(A);
    const offerId = randomUUID();
    expect((await h.transfers.createOffer({ offerId, ticketId: given.tickets[0]!.ticketId, fromAccountId: A, toAccountId: B, status: 'OFFERED', expiresAtMs: NOW + 2 * DAY, createdAtMs: NOW }, h.clock.now())).kind).toBe('CREATED');
    expect((await h.transfers.accept({ offerId, accountId: B, nowMs: h.clock.now() })).kind).toBe('OK');
    const locked = await h.issue(A, { eventId: OTHER_EVENT });
    const lockOut = await h.transfers.setTransferLock({ caseId: randomUUID(), version: 1, locked: true, eventId: OTHER_EVENT, accountIds: [A], expiresAtMs: h.clock.now() + 14 * DAY, nowMs: h.clock.now() });
    expect(lockOut.map((x) => x.result)).toEqual(['LOCKED']);

    const received = (await h.get('', { account: B })).body.items ?? [];
    expect(received.map((i) => i.ticketId)).toEqual([given.tickets[0]!.ticketId]);
    expect('receivedFromNickname' in received[0]!, '받은 표에 receivedFromNickname 칸이 있다(받은 표의 닉네임은 ticket 데이터에 없다)').toBe(false);
    expect(received[0]!.status).toBe('ACTIVE');
    expect(received[0]!.transferLocked).toBe(false);

    const mine = (await h.get('')).body.items ?? [];
    expect(mine.map((i) => [i.ticketId, i.transferLocked])).toEqual([[locked.tickets[0]!.ticketId, true]]);
    expect(mine[0]!.receivedFromNickname).toBeNull();
  });

  // 팬이 아닌 신원의 상태 값: O-T47 ⑥ 판정 칸은 403이지만 docs/security/authz-matrix.md 200행('다른 대상의 토큰은 역할과 상관없이 401')과
  // 플랫폼 공용 가드(대상이 다르면 신원을 인정하지 않는다)는 401이다. 정본끼리 어긋나 이 시험은 authz-matrix를 따른다(계획 10절 '시험이 기댄 모양' 1)
  test('O-T47 ⑥ 세션 없으면 401, 팬이 아닌 신원(partner·ops·scanner)도 표 없이 401, 쿼리 accountId는 무시한다', async () => {
    const h = await harness();
    const a = await h.issue(A);
    await h.issue(B);
    expect((await h.get('', { account: '', session: '', aud: '' })).status).toBe(401);
    expect((await h.get('', { session: '' })).status).toBe(401);
    expect((await h.get('', { account: '' })).status).toBe(401);
    for (const aud of ['partner', 'ops', 'scanner']) {
      const p = await h.get('', { aud });
      expect(p.status, `x-user-aud ${aud}`).toBe(401);
      expect(p.raw.includes(a.tickets[0]!.ticketId), `${aud}에게 표를 줬다`).toBe(false);
    }
    // 쿼리의 계정 값은 읽지 않는다(머리의 계정만)
    const p = await h.get(`?accountId=${B}`);
    expect(p.status, p.raw).toBe(200);
    expect(idsOf(p)).toEqual(orderTicketIds(a));
  });

  test('O-T47 ⑦ 양도 수락 뒤 그 표는 B의 목록에만 있다(결제자 칸이 아니라 보유자 칸으로 거른다)', async () => {
    const h = await harness();
    const kept = await h.issue(A);
    const given = await h.issue(A);
    const offerId = randomUUID();
    expect((await h.transfers.createOffer({ offerId, ticketId: given.tickets[0]!.ticketId, fromAccountId: A, toAccountId: B, status: 'OFFERED', expiresAtMs: NOW + 2 * DAY, createdAtMs: NOW }, h.clock.now())).kind).toBe('CREATED');
    expect((await h.transfers.accept({ offerId, accountId: B, nowMs: h.clock.now() })).kind).toBe('OK');
    expect(idsOf(await h.get(''))).toEqual(orderTicketIds(kept));
    expect(idsOf(await h.get('', { account: B }))).toEqual(orderTicketIds(given));
  });

  test('O-T47 ⑧ 200·400 모두 private, no-store이고 기록 줄에 티켓 키·PEAKET1 값·응답 본문이 없다(ASVS v5.0.0-14.2.2, v5.0.0-14.3.2, v5.0.0-16.2.5)', async () => {
    const h = await harness();
    const issued = [await h.issue(A, { seats: 2 }), await h.issue(A)];
    const ok = await h.get('?limit=2');
    expect(ok.status, ok.raw).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');
    const badLimit = await h.get('?limit=101');
    expect(badLimit.status).toBe(400);
    expect(badLimit.headers['cache-control']).toBe('private, no-store');
    const badCursor = await h.get('?cursor=%25%25%25');
    expect(badCursor.status).toBe(400);
    expect(badCursor.headers['cache-control']).toBe('private, no-store');

    // 정규 기록 줄: 경로·상태가 있다(빈 기록으로 통과하지 않게)
    const lines = h.logs.flatMap((chunk) => chunk.split('\n')).filter((l) => l.trim() !== '');
    const parsed = lines.map((l) => {
      try {
        return JSON.parse(l) as { route?: unknown; status?: unknown };
      } catch {
        return {};
      }
    });
    const statuses = parsed.filter((l) => l.route === '/v1/tickets').map((l) => l.status);
    expect(statuses).toEqual(expect.arrayContaining([200, 400]));
    const all = lines.join('\n');
    for (const r of issued) {
      for (const t of r.tickets) {
        expect(all.includes(String(t.ticketKey)), '기록에 티켓 키').toBe(false);
        expect(all.includes(t.keyHash), '기록에 키 해시').toBe(false);
        expect(all.includes(t.ticketId), '기록에 응답 본문의 티켓 ID').toBe(false);
      }
    }
    expect(all.includes('PEAKET1:')).toBe(false);
    expect(all.includes(String(ok.body.nextCursor)), '기록에 커서 값').toBe(false);
  });

  test('O-T47 장애: 저장소 목록 읽기가 실패하면 500이고 내부 글·표를 싣지 않는다', async () => {
    const h = await harness({ store: new BrokenListStore() });
    await h.issue(A);
    const p = await h.get('');
    expect(p.status, p.raw).toBe(500);
    expect(p.body.items).toBeUndefined();
    expect(p.raw.includes('ECONNREFUSED')).toBe(false);
    expect(p.raw.includes('10.0.0.9')).toBe(false);
  });
});

describe('월렛 목록 쓰임새 [O-T47]', () => {
  test('FWAL-GRPC ① 풀리지 않는 커서는 TicketService.list가 TicketInputError로 거절한다(gRPC ListTickets의 INVALID_ARGUMENT 자리)', async () => {
    const tickets = new TicketService({ store: new MemoryTicketStore(), clock: fakeClock({ now: NOW }) });
    await expect(tickets.list({ accountId: A, cursor: '%%%', limit: 10 })).rejects.toBeInstanceOf(TicketInputError);
    await expect(tickets.list({ accountId: A, cursor: Buffer.from('[1]', 'utf8').toString('base64url'), limit: 10 })).rejects.toBeInstanceOf(TicketInputError);
    // 커서가 없으면 처음 쪽(빈 목록)
    await expect(tickets.list({ accountId: A, limit: 10 })).resolves.toMatchObject({ tickets: [] });
  });
});
