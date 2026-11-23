// F-05-2 양도 앞 몫 서버 단위 시험(BUILD_ORDER GAT-050·GAT-055, 계획 docs/review/plans/F-05-2.md §4·§5 T1~T8).
// 시험 담당(lane2-f052-test)이 구현 전에 썼다(ADR-0372·0381). 기준 트리에서 새 동작은 실패한다('실패 확인' 절).
// 정본: docs/features/transfer-refund.md §3.1·§4·§4.1·§5·§7.4 ①·§11(R-T1·R-T2·R-T17·R-T25), docs/security/asvs/transfer-refund.md(2.3.3·2.3.4·2.4.1·8.2.2·11.1.1),
//       docs/api/openapi.yaml(Ticket·TransferOffer·TransferOfferPage·getTicket·listTransfers·createTransferRecipientLookup·TooManyRequests),
//       docs/api/guidelines.md §3(커서)·§4(멱등 키 '돌려주는 응답'·'다른 본문'), docs/features/offline-gate.md §2 '무엇을 싣나', POL-017.
// - 진짜: 처리기·Transfers·TicketService·도메인 규칙·플랫폼 계약 검사. 바꿔 끼운 것은 저장소 포트(MemoryTicketStore·MemoryTransferStore·MemoryDeviceKeyStore,
//   포트를 implements한 짝 가짜), 시계(fakeClock), 재인증 확인 포트(TransferReauthGate, 늘 통과), identity 회원 코드 찾기 포트(MemberCodeDirectory)뿐이다.
//   같은 동작을 실제 PostgreSQL로 덮는 시험은 test-int/transfer-f052.int.test.ts(같은 T 번호)다.
// - 생성자 모양은 지금 그대로 쓴다: TicketService({store, clock}), MemoryTransferStore({tickets, revokeKey}), Transfers({store, reauth, recipientRefSecret, clock, directory}).
// - 시험 값은 정본 예와 다르게 고른다(회원 코드 QZ7-4K2M, 공연 시작 19:37 KST 같은 어긋난 분).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { GetTicketResponse, GetTransferResponse, ListTransfersResponse } from '@peaket/contracts/openapi/tickets';
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
import { Transfers } from '../src/modules/ticket/application/transfers.js';
import type { TicketStatus } from '../src/modules/ticket/domain/ticket.js';
import type { MemberCodeDirectory } from '../src/modules/ticket/domain/transfer-ports.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 2026-11-23 10:00 KST. 정본 예(10/25)와 다른 날 */
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
/** 공연 시작: 9일 뒤 19:37 KST(어긋난 분). 양도 마감은 그 2시간 전(POL-017) */
const STARTS = Date.parse('2026-12-02T10:37:00.000Z');
const CLOSE = STARTS - 2 * HOUR;
const A = '0193f2c0-0000-7000-8000-00000052a001'; // 결제자(보낸 사람)
const B = '0193f2c0-0000-7000-8000-00000052b002'; // 받는 사람
const C = '0193f2c0-0000-7000-8000-00000052c003'; // 상관없는 계정
const SESSION = '0193f2c0-0000-7000-8000-00000052d004';
const EVENT = '0193f2c0-0000-7000-8000-00000052e001';
const OTHER_EVENT = '0193f2c0-0000-7000-8000-00000052e002';
const SECRET = 'f052-unit-secret';
/** 받는 분 회원 코드(정본 예 'ABC-1234'와 다른 값) */
const CODE_B = 'QZ7-4K2M';
/** 상관없는 계정 C의 회원 코드 */
const CODE_C = 'HN3-8WQP';

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

/** identity 회원 코드 찾기 포트의 짝 가짜. 부른 코드를 적고, fail이 참이면 gRPC 클라이언트처럼 던진다(GrpcMemberCodeDirectory와 같은 실패 모양) */
class RecordingDirectory implements MemberCodeDirectory {
  readonly calls: string[] = [];
  fail = false;
  async resolveMemberCode(code: string): Promise<{ accountId: string; nickname: string } | undefined> {
    this.calls.push(code);
    if (this.fail) throw new Error('14 UNAVAILABLE: identity-svc 연결 실패');
    if (code === CODE_B) return { accountId: B, nickname: '회원' };
    if (code === CODE_C) return { accountId: C, nickname: '회원' };
    return undefined;
  }
}

interface Res {
  readonly status: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly raw: string;
  readonly body: Record<string, unknown>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => {});
});

/** 시험마다 새 서비스·저장소·시계(TA-V01). revoked는 저장소가 키를 폐기한 표 ID 기록(보유자 바꿈마다 한 번) */
async function harness() {
  const clock: FakeClock = fakeClock({ now: NOW });
  const tickets = new MemoryTicketStore();
  const revoked: string[] = [];
  const store = new MemoryTransferStore({ tickets, revokeKey: (ticketId) => void revoked.push(ticketId) });
  const service = new TicketService({ store: tickets, clock });
  const directory = new RecordingDirectory();
  const transfers = new Transfers({ store, reauth: { verify: async () => true }, recipientRefSecret: SECRET, clock, directory });
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
  const devices = new MemoryScannerDeviceStore();
  const svc = await createService({
    name: 'ticket-svc-transfer-f052',
    module: AppModule.register({
      scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay, gate, shift: new MemoryScannerShiftStore(gate) },
      ticket: { deviceKeys: new DeviceKeys({ store: deviceKeysStore, clock }), tickets: service, transfers },
    }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' },
    clock,
    logDestination: sink,
    adminAuthz: new FakeAdmin(),
    scanner: { devices, sessions: new FakeSessions(), replay },
  });
  closers.push(() => svc.close());

  const send = async (method: 'GET' | 'POST', url: string, account: string | null, o: { body?: unknown; key?: string; reauth?: string } = {}): Promise<Res> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (account !== null) Object.assign(headers, { 'x-user-id': account, 'x-session-id': SESSION, 'x-user-aud': 'fan' });
    if (o.key !== undefined) headers['idempotency-key'] = o.key;
    if (o.reauth !== undefined) headers['x-reauth-token'] = o.reauth;
    const r = await svc.http.inject({ method, url, headers, ...(method === 'POST' ? { payload: JSON.stringify(o.body ?? {}) } : {}) });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: r.statusCode, headers: r.headers, raw: r.payload, body };
  };
  const get = (url: string, account: string | null = A) => send('GET', url, account);
  const post = (url: string, account: string, o: { body?: unknown; key?: string; reauth?: string } = {}) => send('POST', url, account, { key: randomUUID(), ...o });

  /** 한 장 발권(결제자 = 보유자). 시계를 1초 민다 */
  const issue = async (o: { payer?: string; eventId?: string; startsAtMs?: number } = {}): Promise<string> => {
    const r = await service.issue({ orderId: randomUUID(), eventId: o.eventId ?? EVENT, payerAccountId: o.payer ?? A, seatIds: [randomUUID()], issueGeneration: 0, eventStartsAtMs: o.startsAtMs ?? STARTS });
    clock.advance(1_000);
    return r.tickets[0]!.ticketId;
  };
  /** 결제자가 받는 사람에게 양도 요청(실제 HTTP 길: 회원 코드 찾기 → 요청). offerId를 돌려준다 */
  const offer = async (ticketId: string, from = A, memberCode = CODE_B): Promise<string> => {
    const found = await post('/v1/transfer-recipient-lookups', from, { body: { memberCode } });
    expect(found.status, found.raw).toBe(200);
    const created = await post(`/v1/tickets/${ticketId}/transfers`, from, { body: { recipientRef: found.body.recipientRef }, reauth: 'r' });
    expect(created.status, created.raw).toBe(201);
    return String(created.body.offerId);
  };
  const ticketRow = (ticketId: string) => tickets.tickets.get(ticketId)!;

  return { svc, clock, tickets, store, service, transfers, directory, revoked, logs, send, get, post, issue, offer, ticketRow };
}

type H = Awaited<ReturnType<typeof harness>>;

/** 회차 취소 표 끝내기 입력(ticket.proto EventCancelTickets의 저장소 길) */
const eventCancelInput = (ticketIds: readonly string[], nowMs: number, ids?: { request?: string; cancellations?: readonly string[] }) => ({
  cancellationRequestId: ids?.request ?? randomUUID(),
  eventId: EVENT,
  targets: ticketIds.map((ticketId, i) => ({ ticketId, cancellationId: ids?.cancellations?.[i] ?? randomUUID() })),
  nowMs,
});

describe('F-05-2 T1 R-T25 ② [ASVS v5.0.0-2.3.3] 회차 취소가 진행 중 양도 요청을 거둔다(메모리 짝)', () => {
  test('F-05-2 T1 R-T25 ② ① 요청이 있는 표 셋과 없는 표 하나를 회차 취소하면 세 요청이 WITHDRAWN·EVENT_CANCELLED·결정 시각이 되고 표 넷은 환급이다', async () => {
    const h = await harness();
    const withOffer = [await h.issue(), await h.issue(), await h.issue()];
    const plain = await h.issue();
    const offers = [];
    for (const t of withOffer) offers.push(await h.offer(t));
    const cancelAt = h.clock.now() + 37 * MIN;
    const out = await h.tickets.eventCancel(eventCancelInput([...withOffer, plain], cancelAt));
    expect(out.map((o) => [o.ticketId, o.result, o.transferWithdrawn, o.holderAccountId])).toEqual([
      [withOffer[0], 'CANCELED', true, A],
      [withOffer[1], 'CANCELED', true, A],
      [withOffer[2], 'CANCELED', true, A],
      [plain, 'CANCELED', false, A],
    ]);
    for (const id of offers) {
      const o = await h.store.getOffer(id);
      expect({ status: o?.status, reason: o?.withdrawReason, decidedAtMs: o?.decidedAtMs }).toEqual({ status: 'WITHDRAWN', reason: 'EVENT_CANCELLED', decidedAtMs: cancelAt });
    }
    expect([...h.store.offers.values()].filter((o) => o.status === 'OFFERED')).toHaveLength(0);
    for (const t of [...withOffer, plain]) expect({ status: h.ticketRow(t).status, pending: h.ticketRow(t).transferPending, holder: h.ticketRow(t).accountId }).toEqual({ status: 'REFUNDED', pending: false, holder: A });
    // 받는 사람이 보는 요청: WITHDRAWN과 공연 취소 사유(화면이 d5 §5.23 '공연이 취소되어 철회된 요청입니다'를 고른다)
    const seen = await h.get(`/v1/transfers/${offers[0]}`, B);
    expect(seen.status, seen.raw).toBe(200);
    expect(seen.body).toMatchObject({ offerId: offers[0], status: 'WITHDRAWN', withdrawReason: 'EVENT_CANCELLED', role: 'RECIPIENT' });
    expect(GetTransferResponse.safeParse(seen.body).success).toBe(true);
    expect(Object.keys(GetTransferResponse.shape)).toContain('withdrawReason');
  });

  test('F-05-2 T1 R-T25 ② ② 같은 취소 ID로 다시 부르면 처음 결과이고 요청의 결정 시각·표가 그대로다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const ids = { request: randomUUID(), cancellations: [randomUUID()] };
    const firstAt = h.clock.now();
    const first = await h.tickets.eventCancel(eventCancelInput([t], firstAt, ids));
    const versionAfter = h.ticketRow(t).version;
    const again = await h.tickets.eventCancel(eventCancelInput([t], firstAt + 5 * MIN, ids));
    expect(again.map((o) => [o.ticketId, o.result, o.holderAccountId])).toEqual(first.map((o) => [o.ticketId, o.result, o.holderAccountId]));
    const o = await h.store.getOffer(offerId);
    expect({ status: o?.status, reason: o?.withdrawReason, decidedAtMs: o?.decidedAtMs }).toEqual({ status: 'WITHDRAWN', reason: 'EVENT_CANCELLED', decidedAtMs: firstAt });
    expect(h.ticketRow(t).version).toBe(versionAfter);
  });

  test('F-05-2 T1 R-T25 ② ③ 되돌림: 대상에 다른 회차 표가 섞이면 던지고 다른 표의 요청도 OFFERED·양도 표시 그대로다(반쪽 0)', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const other = await h.issue({ eventId: OTHER_EVENT });
    const before = { ...h.ticketRow(t) };
    await expect(h.tickets.eventCancel(eventCancelInput([t, other], h.clock.now()))).rejects.toThrow();
    expect((await h.store.getOffer(offerId))?.status).toBe('OFFERED');
    expect(h.ticketRow(t)).toEqual(before);
    expect(h.ticketRow(t)).toMatchObject({ status: 'TRANSFER_PENDING', transferPending: true });
  });
});

describe('F-05-2 T2 R-T25 ② 운영자 취소가 진행 중 양도 요청을 거둔다(메모리 짝, 정본 transfer-refund §7.4 ① FRAUD_LOCK)', () => {
  test('F-05-2 T2 R-T25 ② ① 진행 중 요청이 있는 표는 WITHDRAWN·FRAUD_LOCK이고 결과에 거둔 요청 ID, 없는 표는 빈칸이며 받는 사람에게는 OTHER로 보인다', async () => {
    const h = await harness();
    const t1 = await h.issue();
    const t2 = await h.issue();
    const offerId = await h.offer(t1);
    const at = h.clock.now() + 11 * MIN;
    const input = { approvalId: randomUUID(), fraudCaseId: randomUUID(), eventId: EVENT, targets: [{ ticketId: t1, expectedHolderAccountId: A }, { ticketId: t2, expectedHolderAccountId: A }], nowMs: at };
    const out = await h.tickets.operatorCancel(input);
    expect(out).toEqual([
      { ticketId: t1, result: 'CANCELED', orderId: h.ticketRow(t1).orderId, withdrawnTransferOfferId: offerId },
      { ticketId: t2, result: 'CANCELED', orderId: h.ticketRow(t2).orderId },
    ]);
    const o = await h.store.getOffer(offerId);
    expect({ status: o?.status, reason: o?.withdrawReason, decidedAtMs: o?.decidedAtMs }).toEqual({ status: 'WITHDRAWN', reason: 'FRAUD_LOCK', decidedAtMs: at });
    expect(h.ticketRow(t1)).toMatchObject({ status: 'REFUNDED', transferPending: false, accountId: A });
    // 받는 사람에게는 부정 예매 사유를 알리지 않는다(§4.1 '받는 사람에게는 사건이나 사유는 알리지 않는다')
    const seen = await h.get(`/v1/transfers/${offerId}`, B);
    expect(seen.status, seen.raw).toBe(200);
    expect(seen.body).toMatchObject({ status: 'WITHDRAWN', withdrawReason: 'OTHER' });
    expect(seen.raw.includes('FRAUD_LOCK')).toBe(false);
    // 같은 승인 ID로 다시 부르면 처음 결과(거둔 요청 ID 포함)
    expect(await h.tickets.operatorCancel({ ...input, nowMs: at + HOUR })).toEqual(out);
    expect((await h.store.getOffer(offerId))?.decidedAtMs).toBe(at);
  });

  test('F-05-2 T2 ② withdrawReason은 WITHDRAWN일 때만 싣고 보낸 사람 철회는 SENDER다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const open = await h.get(`/v1/transfers/${offerId}`, B);
    expect(open.body.status).toBe('OFFERED');
    expect('withdrawReason' in open.body).toBe(false);
    expect((await h.post(`/v1/transfers/${offerId}/withdrawal`, A)).status).toBe(200);
    const closed = await h.get(`/v1/transfers/${offerId}`, B);
    expect(closed.body).toMatchObject({ status: 'WITHDRAWN', withdrawReason: 'SENDER' });
  });
});

describe('F-05-2 T3 R-T25 ② [ASVS v5.0.0-2.3.4] 환급된 표는 받아도 쓸 수 없다', () => {
  test('F-05-2 T3 R-T25 ② ① 회차 취소·운영자 취소 뒤 받는 사람이 수락하면 409 transfer-not-offered이고 표·보유자·버전이 그대로다', async () => {
    const h = await harness();
    const t1 = await h.issue();
    const t2 = await h.issue();
    const o1 = await h.offer(t1);
    const o2 = await h.offer(t2);
    await h.tickets.eventCancel(eventCancelInput([t1], h.clock.now()));
    await h.tickets.operatorCancel({ approvalId: randomUUID(), fraudCaseId: randomUUID(), eventId: EVENT, targets: [{ ticketId: t2, expectedHolderAccountId: A }], nowMs: h.clock.now() });
    for (const [t, o] of [
      [t1, o1],
      [t2, o2],
    ] as const) {
      const before = { ...h.ticketRow(t) };
      const revokedBefore = h.revoked.length;
      const r = await h.post(`/v1/transfers/${o}/acceptance`, B);
      expect(r.status, r.raw).toBe(409);
      expect(String(r.body.type)).toContain('transfer-not-offered');
      expect(h.ticketRow(t)).toEqual(before);
      expect(h.ticketRow(t)).toMatchObject({ status: 'REFUNDED', accountId: A });
      expect(h.revoked.length).toBe(revokedBefore);
      // 받는 사람의 월렛 목록·상세에 그 표가 없다
      const list = await h.get('/v1/tickets', B);
      expect(((list.body.items as unknown[] | undefined) ?? []).length).toBe(0);
      expect((await h.get(`/v1/tickets/${t}`, B)).status).toBe(404);
    }
  });

  const ENDED: readonly TicketStatus[] = ['REFUNDED', 'VOIDED', 'CANCEL_REQUESTED', 'FLAGGED'];
  for (const status of ENDED) {
    test(`F-05-2 T3 R-T25 ② ② 겹친 가드: 요청이 OFFERED로 남은 채 표만 ${status}이면 수락은 409 ticket-ended이고 요청·보유자·키가 그대로다`, async () => {
      const h = await harness();
      const t = await h.issue();
      const offerId = await h.offer(t);
      // D1 길을 거치지 않고 표 상태만 바꾼다(옛 데이터·다른 길의 상태 바꿈, 계획 §1 한다 2)
      h.tickets.tickets.set(t, { ...h.ticketRow(t), status });
      const before = { ...h.ticketRow(t) };
      const r = await h.post(`/v1/transfers/${offerId}/acceptance`, B);
      expect(r.status, r.raw).toBe(409);
      expect(String(r.body.type)).toContain('ticket-ended');
      expect((await h.store.getOffer(offerId))?.status).toBe('OFFERED');
      expect(h.ticketRow(t)).toEqual(before);
      expect(h.revoked).toEqual([]);
    });
  }

  for (const status of ['ACTIVE', 'TRANSFER_PENDING'] as const) {
    test(`F-05-2 T3 R-T25 ② ③ 경계 반대쪽: 표가 ${status}이면 받는다(200, 보유자 = 받는 사람, 보낸 사람 키 폐기 한 번)`, async () => {
      const h = await harness();
      const t = await h.issue();
      const offerId = await h.offer(t);
      h.tickets.tickets.set(t, { ...h.ticketRow(t), status });
      const r = await h.post(`/v1/transfers/${offerId}/acceptance`, B);
      expect(r.status, r.raw).toBe(200);
      expect(r.body).toMatchObject({ offerId, status: 'ACCEPTED' });
      expect(h.ticketRow(t)).toMatchObject({ accountId: B, status: 'ACTIVE', transferPending: false });
      expect(h.revoked).toEqual([t]);
    });
  }

  test('F-05-2 T3 ④ 이미 수락한 요청을 같은 키로 다시 보내면 200 재생이고 표는 한 번만 바뀐다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const key = randomUUID();
    const first = await h.post(`/v1/transfers/${offerId}/acceptance`, B, { key });
    expect(first.status, first.raw).toBe(200);
    const v = h.ticketRow(t).version;
    const again = await h.post(`/v1/transfers/${offerId}/acceptance`, B, { key });
    expect(again.status, again.raw).toBe(200);
    expect(again.body).toMatchObject({ offerId, status: 'ACCEPTED' });
    expect(h.ticketRow(t).version).toBe(v);
    expect(h.revoked).toEqual([t]);
  });
});

describe('F-05-2 T4 [ASVS v5.0.0-8.2.2] 티켓 상세 GET /v1/tickets/{ticketId}', () => {
  const problemOf = (r: Res) => ({ status: r.status, type: r.body.type, title: r.body.title, detail: r.body.detail });

  test('F-05-2 T4 ① 지금 보유자만 200이고 남의 것·없는 것·UUID 아님은 같은 404 본문이다', async () => {
    const h = await harness();
    const t = await h.issue();
    const mine = await h.get(`/v1/tickets/${t}`, A);
    expect(mine.status, mine.raw).toBe(200);
    expect(mine.body).toMatchObject({ ticketId: t, eventId: EVENT });
    const others = await h.get(`/v1/tickets/${t}`, C);
    const missing = await h.get(`/v1/tickets/${randomUUID()}`, A);
    const notUuid = await h.get('/v1/tickets/tkt-lumen-r1-0312', A);
    expect(others.status).toBe(404);
    expect(String(others.body.type)).toContain('not-found');
    expect(problemOf(missing)).toEqual(problemOf(others));
    expect(problemOf(notUuid)).toEqual(problemOf(others));
  });

  test('F-05-2 T4 ② 결제자 표: transferable 참, transferDeadline = 공연 시작 − 2시간, receivedFromNickname null, pendingTransfer는 요청이 있을 때만', async () => {
    const h = await harness();
    const t = await h.issue();
    const d = await h.get(`/v1/tickets/${t}`, A);
    expect(d.status, d.raw).toBe(200);
    expect(d.body).toMatchObject({ transferable: true, transferLocked: false, receivedFromNickname: null, pendingTransfer: null, transferLockExpiresAt: null });
    expect(Date.parse(String(d.body.transferDeadline))).toBe(CLOSE);
    expect(Date.parse(String(d.body.eventStartsAt))).toBe(STARTS);
    const offerId = await h.offer(t);
    const after = await h.get(`/v1/tickets/${t}`, A);
    // 요청 기한 = min(요청 + 48시간, 양도 마감)(POL-017). 여기서는 48시간이 이르다
    const pt = after.body.pendingTransfer as { offerId: string; expiresAt: string };
    expect(pt.offerId).toBe(offerId);
    expect(Date.parse(pt.expiresAt)).toBe(h.clock.now() + 48 * HOUR);
    expect(Object.keys(pt).sort()).toEqual(['expiresAt', 'offerId']);
  });

  test('F-05-2 T4 ③ 받은 표: transferable 거짓, receivedFromNickname 글, 잠겼어도 transferLockExpiresAt·pendingTransfer는 null', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    expect((await h.post(`/v1/transfers/${offerId}/acceptance`, B)).status).toBe(200);
    await h.transfers.setTransferLock({ caseId: randomUUID(), version: 1, locked: true, eventId: EVENT, accountIds: [A], expiresAtMs: h.clock.now() + 14 * DAY, nowMs: h.clock.now() });
    const d = await h.get(`/v1/tickets/${t}`, B);
    expect(d.status, d.raw).toBe(200);
    expect(d.body.transferable).toBe(false);
    expect(typeof d.body.receivedFromNickname).toBe('string');
    expect(String(d.body.receivedFromNickname).length).toBeGreaterThan(0);
    expect(d.body.transferLockExpiresAt).toBeNull();
    expect(d.body.pendingTransfer).toBeNull();
    // 받은 사람 응답에 결제자 계정 ID가 없다(authz-matrix §4.1)
    expect(d.raw.includes(A)).toBe(false);
    // 결제자는 이제 보유자가 아니라 404
    expect((await h.get(`/v1/tickets/${t}`, A)).status).toBe(404);
  });

  test('F-05-2 T4 ④ 경계: 양도 마감 − 1ms는 transferable 참, 마감 0ms는 거짓', async () => {
    const h = await harness();
    const t = await h.issue();
    h.clock.advance(CLOSE - 1 - h.clock.now());
    expect((await h.get(`/v1/tickets/${t}`, A)).body.transferable).toBe(true);
    h.clock.advance(1);
    expect((await h.get(`/v1/tickets/${t}`, A)).body.transferable).toBe(false);
  });

  test('F-05-2 T4 ⑤ 경계: 잠금 기한 − 1ms는 transferLocked 참과 기한, 기한 0ms는 거짓과 null(§4.1 그 시각 뒤에는 칸이 남아 있어도)', async () => {
    const h = await harness();
    const t = await h.issue();
    const expiresAtMs = h.clock.now() + 5 * HOUR + 17 * MIN;
    await h.transfers.setTransferLock({ caseId: randomUUID(), version: 1, locked: true, eventId: EVENT, accountIds: [A], expiresAtMs, nowMs: h.clock.now() });
    h.clock.advance(expiresAtMs - 1 - h.clock.now());
    const before = await h.get(`/v1/tickets/${t}`, A);
    expect(before.body.transferLocked).toBe(true);
    expect(Date.parse(String(before.body.transferLockExpiresAt))).toBe(expiresAtMs);
    h.clock.advance(1);
    const after = await h.get(`/v1/tickets/${t}`, A);
    expect(after.body.transferLocked).toBe(false);
    expect(after.body.transferLockExpiresAt).toBeNull();
  });

  test('F-05-2 T4 ⑥ [ASVS v5.0.0-14.3.2] 200·404·401 모두 Cache-Control: private, no-store이고 응답 칸은 계약 Ticket 안이다', async () => {
    const h = await harness();
    const t = await h.issue();
    const ok = await h.get(`/v1/tickets/${t}`, A);
    const nf = await h.get(`/v1/tickets/${randomUUID()}`, A);
    const anon = await h.get(`/v1/tickets/${t}`, null);
    expect([ok.status, nf.status, anon.status]).toEqual([200, 404, 401]);
    for (const r of [ok, nf, anon]) expect(r.headers['cache-control']).toBe('private, no-store');
    const allowed = Object.keys(GetTicketResponse.shape);
    expect(allowed).toContain('pendingTransfer');
    for (const k of Object.keys(ok.body)) expect(allowed, `계약 밖 칸 ${k}`).toContain(k);
    expect(GetTicketResponse.safeParse(ok.body).success).toBe(true);
    // 계약 밖 값(주문·좌석 ID, QR 포인터, 키)이 없다
    const row = h.ticketRow(t);
    for (const v of [row.orderId, row.seatId, row.keyHash, row.qrPayload]) expect(ok.raw.includes(v)).toBe(false);
  });
});

describe('F-05-2 T5 월렛 목록과 상세 짝', () => {
  test('F-05-2 T5 ① 목록 항목의 칸은 모두 상세에 같은 값으로 있고, pendingTransfer는 요청 뒤 그 요청·철회 뒤 null이다', async () => {
    const h = await harness();
    const t = await h.issue();
    const itemOf = async () => ((await h.get('/v1/tickets', A)).body.items as Array<Record<string, unknown>>).find((i) => i.ticketId === t)!;
    const detail = async () => (await h.get(`/v1/tickets/${t}`, A)).body;
    const pair = async () => {
      const [i, d] = [await itemOf(), await detail()];
      for (const [k, v] of Object.entries(i)) expect(d[k], `목록 칸 ${k}`).toEqual(v);
      return i;
    };
    expect((await pair()).pendingTransfer).toBeNull();
    const offerId = await h.offer(t);
    expect(((await pair()).pendingTransfer as { offerId: string }).offerId).toBe(offerId);
    expect((await h.post(`/v1/transfers/${offerId}/withdrawal`, A)).status).toBe(200);
    expect((await pair()).pendingTransfer).toBeNull();
  });

  test('F-05-2 T5 ② R-T1 48시간 만료 경계: 기한 − 1ms에는 pendingTransfer가 있고 만료 정비 뒤에는 null·transferable 참이다', async () => {
    const h = await harness();
    const t = await h.issue();
    const offerId = await h.offer(t);
    const expiresAt = h.clock.now() + 48 * HOUR;
    h.clock.advance(expiresAt - 1 - h.clock.now());
    expect(await h.transfers.expireOffers()).toBe(0);
    expect(((await h.get(`/v1/tickets/${t}`, A)).body.pendingTransfer as { offerId: string }).offerId).toBe(offerId);
    h.clock.advance(1);
    expect(await h.transfers.expireOffers()).toBe(1);
    const d = await h.get(`/v1/tickets/${t}`, A);
    expect(d.status, d.raw).toBe(200);
    expect(d.body).toMatchObject({ pendingTransfer: null, transferable: true });
    // 받는 사람이 만료 뒤 수락하면 409 transfer-expired(R-T1)
    const late = await h.post(`/v1/transfers/${offerId}/acceptance`, B);
    expect(late.status).toBe(409);
    expect(String(late.body.type)).toContain('transfer-expired');
  });
});

describe('F-05-2 T6 [ASVS v5.0.0-8.2.2] 받은 요청 목록 GET /v1/transfers', () => {
  test('F-05-2 T6 ① 받는 사람으로 지정된 요청만 최근 순, status 거르기, 커서로 끝까지 겹침·빠짐 0', async () => {
    const h = await harness();
    const toB: string[] = [];
    for (let i = 0; i < 4; i++) {
      toB.push(await h.offer(await h.issue()));
      h.clock.advance(7 * MIN);
    }
    // B가 보낸 요청(B가 결제자인 표 → C)과 남의 요청(A → C)은 B의 받은 목록에 없다
    const fromB = await h.offer(await h.issue({ payer: B }), B, CODE_C);
    const aToC = await h.offer(await h.issue(), A, CODE_C);
    expect((await h.post(`/v1/transfers/${toB[1]}/withdrawal`, A)).status).toBe(200);

    const all = await h.get('/v1/transfers', B);
    expect(all.status, all.raw).toBe(200);
    expect(all.headers['cache-control']).toBe('private, no-store');
    const items = all.body.items as Array<Record<string, unknown>>;
    expect(items.filter((i) => toB.includes(String(i.offerId))).map((i) => i.offerId)).toEqual([...toB].reverse());
    for (const i of items) expect(i.role).toBe('RECIPIENT');
    expect(items.map((i) => i.offerId)).not.toContain(fromB);
    expect(items.map((i) => i.offerId)).not.toContain(aToC);
    expect(ListTransfersResponse.safeParse(all.body).success).toBe(true);

    const offered = await h.get('/v1/transfers?status=OFFERED', B);
    expect((offered.body.items as Array<Record<string, unknown>>).filter((i) => toB.includes(String(i.offerId))).map((i) => i.offerId)).toEqual([toB[3], toB[2], toB[0]]);
    for (const i of offered.body.items as Array<Record<string, unknown>>) expect(i.status).toBe('OFFERED');

    // 커서로 한 건씩 끝까지
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 20; n++) {
      const page = await h.get(`/v1/transfers?status=OFFERED&limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, B);
      expect(page.status, page.raw).toBe(200);
      seen.push(...(page.body.items as Array<{ offerId: string }>).map((i) => i.offerId));
      cursor = (page.body.nextCursor as string | null | undefined) ?? null;
      if (cursor === null) break;
    }
    expect(seen).toEqual((offered.body.items as Array<{ offerId: string }>).map((i) => i.offerId));
    expect(new Set(seen).size).toBe(seen.length);

    // 보낸 사람 A·상관없는 C의 받은 목록에는 이 요청들이 없다
    for (const who of [A, C]) {
      const other = await h.get('/v1/transfers', who);
      expect(other.status).toBe(200);
      expect((other.body.items as Array<{ offerId: string }>).filter((i) => toB.includes(i.offerId))).toEqual([]);
    }
    // 결제 금액·결제자 연락처·예매번호·결제자 계정 ID가 없다
    for (const k of ['amount', 'price', 'payerPhone', 'phoneNumber', 'email', 'bookingNumber', 'payerAccountId']) expect(all.raw.includes(`"${k}"`)).toBe(false);
    expect(all.raw.includes(A)).toBe(false);
  });

  test('F-05-2 T6 ② 모르는 status·풀리지 않는 커서는 400 invalid-query, 세션이 없으면 401이고 모두 private, no-store다', async () => {
    const h = await harness();
    const bad = await h.get('/v1/transfers?status=PENDING', B);
    const badCursor = await h.get('/v1/transfers?cursor=%E2%9C%97not-a-cursor', B);
    const anon = await h.get('/v1/transfers', null);
    expect([bad.status, badCursor.status, anon.status]).toEqual([400, 400, 401]);
    expect(String(badCursor.body.type)).toContain('invalid-query');
    for (const r of [bad, badCursor, anon]) expect(r.headers['cache-control']).toBe('private, no-store');
  });
});

describe('F-05-2 T7 [ASVS v5.0.0-2.4.1] 받는 사람 조회 한도(계정당 시간당 10회 [가정], openapi createTransferRecipientLookup)', () => {
  const lookup = (h: H, account: string, memberCode: string) => h.post('/v1/transfer-recipient-lookups', account, { body: { memberCode } });

  test('F-05-2 T7 ① 60분 안 10번까지 200·404, 11번째는 429와 Retry-After(첫 조회가 창에서 빠질 때까지의 초)이고 identity를 부르지 않는다', async () => {
    const h = await harness();
    const start = h.clock.now();
    for (let i = 0; i < 10; i++) {
      const r = await lookup(h, A, i % 3 === 0 ? 'NO-SUCH-1' : CODE_B);
      expect(r.status, `${i + 1}번째`).toBe(i % 3 === 0 ? 404 : 200);
      h.clock.advance(MIN);
    }
    const calls = h.directory.calls.length;
    expect(calls).toBe(10);
    const limited = await lookup(h, A, CODE_B);
    expect(limited.status, limited.raw).toBe(429);
    expect(String(limited.body.type)).toContain('too-many-requests');
    expect(limited.headers['retry-after']).toBe(String((start + 60 * MIN - h.clock.now()) / 1000));
    expect(h.directory.calls.length).toBe(calls);
    // 다른 계정은 영향이 없다
    expect((await lookup(h, C, CODE_B)).status).toBe(200);
  });

  test('F-05-2 T7 ② 경계: 첫 조회 + 60분 − 1ms는 429(Retry-After 1), + 60분은 다시 된다(429는 세지 않는다)', async () => {
    const h = await harness();
    const start = h.clock.now();
    for (let i = 0; i < 10; i++) expect((await lookup(h, A, CODE_B)).status).toBe(200);
    h.clock.advance(60 * MIN - 1);
    const edge = await lookup(h, A, CODE_B);
    expect(edge.status).toBe(429);
    expect(edge.headers['retry-after']).toBe('1');
    h.clock.advance(1);
    expect(h.clock.now()).toBe(start + 60 * MIN);
    expect((await lookup(h, A, CODE_B)).status).toBe(200);
    // 첫 열 번이 같은 시각이라 이제 열 번이 함께 빠졌고, 새 창에서 9번 더 된다
    for (let i = 0; i < 9; i++) expect((await lookup(h, A, CODE_B)).status).toBe(200);
    expect((await lookup(h, A, CODE_B)).status).toBe(429);
  });

  test('F-05-2 T7 ③ 장애 주입: identity 회원 코드 찾기가 실패하면 503 dependency-unavailable(성공·404로 읽지 않음)이고 그 시도도 센다', async () => {
    const h = await harness();
    for (let i = 0; i < 9; i++) expect((await lookup(h, A, CODE_B)).status).toBe(200);
    h.directory.fail = true;
    const down = await lookup(h, A, CODE_B);
    expect(down.status, down.raw).toBe(503);
    expect(String(down.body.type)).toContain('dependency-unavailable');
    expect(down.headers['retry-after']).toBe('1');
    expect('recipientRef' in down.body).toBe(false);
    h.directory.fail = false;
    expect((await lookup(h, A, CODE_B)).status).toBe(429);
  });

  test('F-05-2 T7 ④ 휴대폰 번호 조회는 지금처럼 404이고 센다, 기록 줄에 회원 코드·번호·찾은 계정 ID가 없다', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i++) {
      const r = await h.post('/v1/transfer-recipient-lookups', A, { body: { phoneNumber: '010-7364-2918' } });
      expect(r.status).toBe(404);
    }
    for (let i = 0; i < 5; i++) expect((await lookup(h, A, CODE_B)).status).toBe(200);
    expect((await lookup(h, A, CODE_B)).status).toBe(429);
    const text = h.logs.join('\n');
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [CODE_B, '010-7364-2918', '01073642918', B]) expect(text.includes(secret), `기록 줄에 ${secret}`).toBe(false);
  });
});

describe('F-05-2 T8 [ASVS v5.0.0-11.1.1] 돌려주기 다시 보냄(같은 Idempotency-Key, BAT-410 RV-08)', () => {
  /** A가 B에게 넘긴 표 하나(수락까지) */
  const given = async (h: H): Promise<string> => {
    const t = await h.issue();
    const offerId = await h.offer(t);
    expect((await h.post(`/v1/transfers/${offerId}/acceptance`, B)).status).toBe(200);
    return t;
  };

  test('F-05-2 T8 ① 돌려주기 200 뒤 같은 키·새 재인증 토큰으로 다시 보내면 첫 본문 그대로 200이고 보유자 바꿈·키 폐기는 한 번이다', async () => {
    const h = await harness();
    const t = await given(h);
    const key = randomUUID();
    const v0 = h.ticketRow(t).version;
    const revoked0 = h.revoked.length;
    const first = await h.post(`/v1/tickets/${t}/returns`, B, { key, reauth: 'token-1' });
    expect(first.status, first.raw).toBe(200);
    expect(first.body).toEqual({ ticketId: t, status: 'RETURNED' });
    expect(h.ticketRow(t)).toMatchObject({ accountId: A, version: v0 + 1 });
    h.clock.advance(3 * MIN);
    const again = await h.post(`/v1/tickets/${t}/returns`, B, { key, reauth: 'token-2' });
    expect(again.status, again.raw).toBe(200);
    expect(again.raw).toBe(first.raw);
    expect(h.ticketRow(t)).toMatchObject({ accountId: A, version: v0 + 1 });
    expect(h.revoked.length).toBe(revoked0 + 1);
  });

  test('F-05-2 T8 ② 같은 키로 다른 표를 돌려주면 422 idempotency-key-reused(guidelines §4 다른 본문)이고 그 표는 그대로다, 다른 키면 지금처럼 404', async () => {
    const h = await harness();
    const t1 = await given(h);
    const t2 = await given(h);
    const key = randomUUID();
    expect((await h.post(`/v1/tickets/${t1}/returns`, B, { key, reauth: 'r' })).status).toBe(200);
    const before = { ...h.ticketRow(t2) };
    const reused = await h.post(`/v1/tickets/${t2}/returns`, B, { key, reauth: 'r' });
    expect(reused.status, reused.raw).toBe(422);
    expect(String(reused.body.type)).toContain('idempotency-key-reused');
    expect(h.ticketRow(t2)).toEqual(before);
    // 받은 사람은 이제 t1의 보유자가 아니다: 다른 키는 새 요청이라 404
    const fresh = await h.post(`/v1/tickets/${t1}/returns`, B, { key: randomUUID(), reauth: 'r' });
    expect(fresh.status).toBe(404);
  });
});
