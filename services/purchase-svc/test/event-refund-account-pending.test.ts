// 계좌 대기(ACCOUNT_PENDING·refund_account_required_at)의 단위 시험(R-T40 ①③④, P-T72 ④⑤, BUILD_ORDER GAT-090, BAT-420-rest, 시험 담당 l3-b420-test).
// 정본: docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현' '계좌 대기', docs/features/transfer-refund.md §3.1 ⑥(틱 끝 다시 열기의 차례·연 시각), §11 R-T40,
// docs/api/proto/peaket/purchase/v1/refund.proto GetEventRefundJobResponse.account_pending_orders.
// - 일괄 환불: 카드 표 둘은 환급되고 가상계좌 주문의 두 표는 ACCOUNT_PENDING으로 끝나 다시 보내지 않으며, 자동 정지 기록(시도)에 들지 않고, 남은 것이 계좌 대기뿐이면 COMPLETED·accountPending 2다.
// - 마감 뒤 환급 실행기: payment가 REFUND_ACCOUNT_REQUIRED로 답하면 계좌 대기 표시만 쓰고(재시도 예약·실패 표시 0), 틱 끝에 환급 실패 건 다음 차례로 '환불 대기' 건을 연다.
// - 어댑터: HttpRefundAccountNotice의 경로·본문·eventKey(refund-account:{취소 ID}의 SHA-256 앞 16바이트), 2xx 밖은 던진다.
// - 시작 조립: start.ts가 견적·팬 취소에 payment-svc gRPC 어댑터를 결제 수단 읽기로 꽂고 차단기 payment-svc-get을 묶는지, 릴레이가 환불 대기 알림을 꽂는지(글 읽기).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import { progressOf, type EventRefundItem, type EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';
import type { EventRefundCanceller } from '../src/modules/refund/domain/event-refund-ports.js';
import { CancelTicketEventRefund, EventTicketCanceller, HttpRefundAccountNotice, MemoryEventRefundAttemptStore, RefundAfterEntry, WeekendBusinessCalendar, eventRefundServiceHandlers } from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-19T05:00:00.000Z');
const REQUEST = '0193a000-0000-7000-8000-000000000401';
const EVENT = '0193a000-0000-7000-8000-000000000402';
const VA_ORDER = '0193a000-0000-7000-8000-0000000004a0';
const CARD1 = '0193a000-0000-7000-8000-0000000004b1';
const CARD2 = '0193a000-0000-7000-8000-0000000004b2';

const target = (orderId: string, ticketId: string): EventRefundTarget => ({
  orderId,
  ticketId,
  seatId: `0193a000-0000-7000-8000-${ticketId.slice(-12)}`.replace(/.$/, 'f'),
  payerAccountId: '0193a000-0000-7000-8000-000000000407',
  ticketPrice: 21_000,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 7 * 86_400_000,
  pg: 'TOSS',
});
const TARGETS = [
  target(CARD1, '0193a000-0000-7000-8000-0000000004c1'),
  target(CARD2, '0193a000-0000-7000-8000-0000000004c2'),
  target(VA_ORDER, '0193a000-0000-7000-8000-0000000004d1'),
  target(VA_ORDER, '0193a000-0000-7000-8000-0000000004d2'),
];

function fixture() {
  const store = new MemoryEventRefundStore();
  const attempts = new MemoryEventRefundAttemptStore();
  const calls: string[] = [];
  const notices: unknown[] = [];
  const finishes: unknown[] = [];
  const originalUpdate = store.updateItem.bind(store);
  store.updateItem = (async (...args: Parameters<typeof store.updateItem>) => {
    finishes.push({ status: args[0].status, ticketId: args[0].ticketId, extra: args[2] });
    return originalUpdate(...args);
  }) as typeof store.updateItem;
  const canceller: EventRefundCanceller = {
    cancel: async (t) => {
      calls.push(t.ticketId);
      return t.orderId === VA_ORDER ? { status: 'ACCOUNT_PENDING' } : { status: 'REFUNDED' };
    },
  };
  const service = new EventRefundService({
    store,
    targets: { list: async () => TARGETS },
    canceller,
    attempts,
    notice: { open: async (q) => void notices.push(q) },
    nowMs: () => NOW,
    deadlineMs: () => NOW + 5_000,
    concurrency: 2,
  });
  return { store, attempts, service, calls, notices, finishes };
}
const start = (service: EventRefundService) => service.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2', fanNoticeReason: '공연 취소' });

describe('R-T40 일괄 환불의 가상계좌 항목 [단위]', () => {
  test('R-T40 ① 카드 주문 둘은 REFUNDED, 가상계좌 주문의 두 표는 ACCOUNT_PENDING으로 끝나고 끝내기에 계좌 대기 표시(accountPending)를 함께 싣는다', async () => {
    const f = fixture();
    await start(f.service);
    const items = [...(await f.store.items(REQUEST))].sort((a, b) => a.ticketId.localeCompare(b.ticketId));
    expect(items.map((i) => [i.orderId, i.status])).toEqual([
      [CARD1, 'REFUNDED'],
      [CARD2, 'REFUNDED'],
      [VA_ORDER, 'ACCOUNT_PENDING'],
      [VA_ORDER, 'ACCOUNT_PENDING'],
    ]);
    const vaFinishes = (f.finishes as { status: string; ticketId: string; extra?: Record<string, unknown> }[]).filter((x) => x.status === 'ACCOUNT_PENDING');
    expect(vaFinishes).toHaveLength(2);
    for (const v of vaFinishes) {
      expect(v.extra).toMatchObject({ accountPending: true });
      expect(v.extra).not.toHaveProperty('cancellationFailure');
      expect(v.extra).not.toHaveProperty('failureCase');
    }
    // 계좌 대기 항목은 재시도 횟수를 올리지 않는다(실패가 아니다)
    for (const i of items.filter((x) => x.status === 'ACCOUNT_PENDING')) expect(i.attempts).toBe(0);
    // 실패 알림(일괄 환불 실패 건)도 열지 않는다
    expect(f.notices).toEqual([]);
  });

  test('R-T40 ③ 계좌 대기 항목은 자동 정지 기록(실패율·연속 실패·실패 금액)에 들지 않고, 다음 틱에 다시 보내지 않는다', async () => {
    const f = fixture();
    await start(f.service);
    expect(f.attempts.attempts.map((a) => [a.ticketId, a.outcome])).toEqual(
      expect.arrayContaining([
        [TARGETS[0]!.ticketId, 'SUCCESS'],
        [TARGETS[1]!.ticketId, 'SUCCESS'],
      ]),
    );
    expect(f.attempts.attempts).toHaveLength(2);
    expect(await f.attempts.consecutiveFailures('TOSS')).toBe(0);
    expect((await f.attempts.windowAll(NOW - 60_000)).failedAmount).toBe(0);
    const before = f.calls.length;
    expect(before).toBe(4);
    await f.service.runDue();
    await f.service.runDue();
    expect(f.calls).toHaveLength(before);
  });

  test('R-T40 ④ 남은 항목이 계좌 대기뿐이면 요청이 COMPLETED이고 진행 합계에 계좌 대기 2가 따로 있다(done 2, failed 0)', async () => {
    const f = fixture();
    const started = await start(f.service);
    const request = await f.store.find(REQUEST);
    expect(request?.status).toBe('COMPLETED');
    expect(started.progress).toMatchObject({ total: 4, done: 2, failed: 0, notApplied: 0, accountPending: 2 });
    expect(request?.progress).toMatchObject({ total: 4, done: 2, failed: 0, accountPending: 2 });
    expect(request?.progress.perPg).toEqual([expect.objectContaining({ pg: 'TOSS', state: 'COMPLETED' })]);
  });

  test('R-T40 ④ progressOf: 계좌 대기 2는 끝난 항목이라 결제사 몫이 COMPLETED이고, 없으면 accountPending 칸이 없다(0으로 읽는다). PENDING 하나가 남으면 RUNNING이다', () => {
    const item = (ticketId: string, status: EventRefundItem['status']): EventRefundItem => ({ requestId: REQUEST, orderId: VA_ORDER, ticketId, cancellationId: ticketId, pg: 'PORTONE', status, attempts: 0 });
    const p = progressOf([item('a', 'REFUNDED'), item('b', 'ACCOUNT_PENDING'), item('c', 'ACCOUNT_PENDING')]);
    expect(p).toMatchObject({ total: 3, done: 1, failed: 0, accountPending: 2 });
    expect(p.perPg[0]).toMatchObject({ pg: 'PORTONE', state: 'COMPLETED' });
    expect(progressOf([item('a', 'REFUNDED')])).not.toHaveProperty('accountPending');
    expect(progressOf([item('b', 'ACCOUNT_PENDING'), item('d', 'PENDING')]).perPg[0]).toMatchObject({ state: 'RUNNING' });
  });

  test('R-T40 ④ GetEventRefundJob 답의 account_pending_orders는 계좌 대기 수(2)이고 없으면 칸을 싣지 않는다', async () => {
    const job = (accountPending?: number) => ({
      requestId: REQUEST,
      eventId: EVENT,
      kind: 'CANCEL',
      status: 'COMPLETED',
      progress: { total: 4, done: 2, failed: 0, notApplied: 0, ...(accountPending === undefined ? {} : { accountPending }), perPg: [] },
    });
    const call = (j: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const handlers = eventRefundServiceHandlers({ get: async () => j } as never);
        (handlers.GetEventRefundJob as (c: unknown, cb: (e: unknown, v?: Record<string, unknown>) => void) => void)({ request: { job_id: REQUEST } }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    expect(await call(job(2))).toMatchObject({ account_pending_orders: 2 });
    expect(await call(job())).not.toHaveProperty('account_pending_orders');
  });

  test('R-T40 ① 취소기 둘 다 payment의 REFUND_ACCOUNT_REQUIRED를 ACCOUNT_PENDING으로 옮긴다(회차 취소 전용·연기 신청)', async () => {
    const view = { orderId: VA_ORDER, eventId: EVENT, ticketId: TARGETS[2]!.ticketId, seatId: TARGETS[2]!.seatId, payerAccountId: TARGETS[2]!.payerAccountId, ticketPrice: 21_000, bookedAtMs: NOW - 86_400_000, saleEndsAtMs: NOW + 7 * 86_400_000, orderStatus: 'CONFIRMED' as const };
    const marks: string[] = [];
    const writes = {
      create: async () => ({ status: 'CREATED' as const }),
      updateStatus: async () => undefined,
      scheduleRefundRetry: async () => undefined,
      markRefundFailed: async () => void marks.push('failed'),
      markRefundAccountRequired: async () => void marks.push('account'),
      dueRefunds: async () => [],
    };
    const payments = { cancel: async () => 'REFUND_ACCOUNT_REQUIRED' as const };
    const dedicated = new EventTicketCanceller({
      tickets: { eventCancel: async () => [{ ticketId: TARGETS[2]!.ticketId, result: 'CANCELLED' }] } as never,
      conversions: { convert: async () => 'CONVERTED' } as never,
      orders: { findByTicket: async () => view, findCancellation: async () => undefined },
      writes,
      payments,
      calendar: new WeekendBusinessCalendar(),
    });
    await expect(dedicated.cancel(TARGETS[2]!, { requestId: REQUEST, eventId: EVENT, cancellationId: TARGETS[2]!.ticketId, nowMs: NOW, deadlineMs: 5_000 } as never)).resolves.toEqual({ status: 'ACCOUNT_PENDING' });
    const postpone = new CancelTicketEventRefund({ execute: async () => ({ status: 'REFUND_PENDING', cancellationId: 'c', refundAmount: 21_000, payment: 'REFUND_ACCOUNT_REQUIRED', refundAccountRequired: true }) } as never);
    await expect(postpone.cancel(TARGETS[2]!, { requestId: REQUEST, eventId: EVENT, cancellationId: 'c', nowMs: NOW, deadlineMs: 5_000 } as never)).resolves.toEqual({ status: 'ACCOUNT_PENDING' });
    const rejected = new CancelTicketEventRefund({ execute: async () => ({ status: 'REFUND_PENDING', cancellationId: 'c', refundAmount: 21_000, payment: 'REJECTED' }) } as never);
    await expect(rejected.cancel(TARGETS[2]!, { requestId: REQUEST, eventId: EVENT, cancellationId: 'c', nowMs: NOW, deadlineMs: 5_000 } as never)).resolves.toEqual({ status: 'FAILED', error: 'REJECTED' });
  });
});

describe('P-T72 ④⑤ 마감 뒤 환급 실행기의 계좌 대기 [단위]', () => {
  const row = (id: string, attempts = 2) => ({ cancellationId: id, orderId: `o-${id}`, ticketId: `t-${id}`, amount: 3_334, reason: 'USER' as const, status: 'REFUND_PENDING' as const, attempts });
  function runner(o: { outcome: 'REFUND_ACCOUNT_REQUIRED' | 'REJECTED'; ops: (kind: string, id: string) => number; failures?: { cancellationId: string; orderId: string; attempts: number; lastError: string }[]; accounts?: { cancellationId: string; orderId: string }[] }) {
    const log: string[] = [];
    const marks: { kind: string; q: unknown }[] = [];
    const opened: string[] = [];
    const signals: string[] = [];
    const failures = o.failures ?? [];
    const accounts = o.accounts ?? [];
    const notice = (kind: string) => ({
      open: async (q: { cancellationId: string }) => {
        log.push(`ops:${kind}:${q.cancellationId}`);
        const status = o.ops(kind, q.cancellationId);
        if (status < 200 || status > 299) throw new Error(`ops ${status}`);
      },
    });
    const r = new RefundAfterEntry({
      nowMs: () => NOW,
      writes: {
        dueRefunds: async () => [row('due-1')],
        updateStatus: async () => undefined,
        scheduleRefundRetry: async (q: unknown) => void marks.push({ kind: 'retry', q }),
        markRefundFailed: async (q: unknown) => void marks.push({ kind: 'failed', q }),
        markRefundAccountRequired: async (q: unknown) => void marks.push({ kind: 'account', q }),
      } as never,
      payments: { cancel: async (q) => (log.push(`pay:${q.cancellationId}`), o.outcome) },
      entries: { lookup: async (ids) => new Map(ids.map((id) => [id, { found: true, entered: false }])) },
      claims: { claimDue: async () => true, markEntryRecorded: async () => true },
      failureNotice: notice('REFUND_FAILED'),
      accountNotice: notice('REFUND_ACCOUNT_PENDING'),
      csOutbox: {
        pendingFlags: async () => [],
        markFlagOpened: async () => undefined,
        pendingRefundFailures: async () => failures.filter((x) => !opened.includes(`REFUND_FAILED:${x.cancellationId}`)),
        markRefundFailureOpened: async (id: string) => void opened.push(`REFUND_FAILED:${id}`),
        pendingRefundAccounts: async () => accounts.filter((x) => !opened.includes(`REFUND_ACCOUNT_PENDING:${x.cancellationId}`)),
        markRefundAccountOpened: async (id: string) => void opened.push(`REFUND_ACCOUNT_PENDING:${id}`),
      },
      csCaseOpenFailures: { inc: (k: string) => void signals.push(k), cut: () => undefined } as never,
      log: { warn: () => undefined, error: () => undefined },
    });
    return { r, log, marks, opened, signals };
  }

  test('P-T72 ④ payment가 REFUND_ACCOUNT_REQUIRED로 답하면 계좌 대기 표시 하나만 쓰고 재시도 예약·실패 표시가 0이며 accountPending 1이다(재시도 횟수 2 그대로)', async () => {
    const f = runner({ outcome: 'REFUND_ACCOUNT_REQUIRED', ops: () => 202 });
    await expect(f.r.run()).resolves.toMatchObject({ refunded: 0, pending: 0, failed: 0, accountPending: 1 });
    expect(f.marks).toEqual([{ kind: 'account', q: { cancellationId: 'due-1', nowMs: NOW } }]);
  });

  test('P-T72 ④ 대조: 업무 거절(REJECTED)은 재시도 횟수를 3으로 올려 실패 표시를 쓰고 accountPending이 없다', async () => {
    const f = runner({ outcome: 'REJECTED', ops: () => 202 });
    const result = await f.r.run();
    expect(result).toMatchObject({ failed: 1 });
    expect(result).not.toHaveProperty('accountPending');
    expect(f.marks).toEqual([{ kind: 'failed', q: expect.objectContaining({ cancellationId: 'due-1', attempts: 3, lastError: 'REJECTED' }) }]);
  });

  test('P-T72 ⑤ 틱 끝 다시 열기는 결제사 호출 뒤에 환급 실패 건 → 환불 대기 건 차례로 열고, 2xx를 받은 행만 연 것으로 적으며, 실패한 행은 지표 REFUND_ACCOUNT_PENDING 하나 뒤 다음 틱에 다시 연다', async () => {
    let accountStatus = 500;
    const f = runner({
      outcome: 'REFUND_ACCOUNT_REQUIRED',
      ops: (kind) => (kind === 'REFUND_ACCOUNT_PENDING' ? accountStatus : 202),
      failures: [{ cancellationId: 'fail-1', orderId: 'o-f', attempts: 1, lastError: 'REJECTED' }],
      accounts: [
        { cancellationId: 'acc-1', orderId: 'o-a1' },
        { cancellationId: 'acc-2', orderId: 'o-a2' },
      ],
    });
    await f.r.run();
    expect(f.log).toEqual(['pay:due-1', 'ops:REFUND_FAILED:fail-1', 'ops:REFUND_ACCOUNT_PENDING:acc-1', 'ops:REFUND_ACCOUNT_PENDING:acc-2']);
    // 장애 주입이 실제로 끼어들었다: 환불 대기 둘 다 500을 받았다
    expect(f.signals).toEqual(['REFUND_ACCOUNT_PENDING', 'REFUND_ACCOUNT_PENDING']);
    expect(f.opened).toEqual(['REFUND_FAILED:fail-1']);
    accountStatus = 202;
    f.log.length = 0;
    await f.r.run();
    expect(f.log).toEqual(['pay:due-1', 'ops:REFUND_ACCOUNT_PENDING:acc-1', 'ops:REFUND_ACCOUNT_PENDING:acc-2']);
    expect(f.opened).toEqual(['REFUND_FAILED:fail-1', 'REFUND_ACCOUNT_PENDING:acc-1', 'REFUND_ACCOUNT_PENDING:acc-2']);
    f.log.length = 0;
    await f.r.run();
    expect(f.log).toEqual(['pay:due-1']);
  });
});

describe('P-T72 ⑤ HttpRefundAccountNotice', () => {
  const CANCELLATION = '0193a000-0000-7000-8000-0000000004e1';
  const expectedKey = () => {
    const h = createHash('sha256').update(`refund-account:${CANCELLATION}`).digest('hex').slice(0, 32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };
  test('P-T72 ⑤ POST /internal/v1/cs-cases에 kind REFUND_ACCOUNT_PENDING·category REFUND·sourceId 취소 ID·eventKey(refund-account:{취소 ID}의 SHA-256 앞 16바이트)와 내부 토큰, 5초 상한으로 보내고 계좌·금액을 싣지 않는다', async () => {
    const seen: Record<string, unknown>[] = [];
    const notice = new HttpRefundAccountNotice({ request: async (r: Record<string, unknown>) => (seen.push(r), new Response('{}', { status: 202 })) } as never, 'it-token');
    await notice.open({ cancellationId: CANCELLATION, orderId: '0193a000-0000-7000-8000-0000000004e2', nowMs: NOW });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/internal/v1/cs-cases', timeoutCapMs: 5_000, headers: { 'content-type': 'application/json', 'x-peaket-internal-token': 'it-token' } });
    expect(JSON.parse(seen[0]!.body as string)).toEqual({ eventKey: expectedKey(), kind: 'REFUND_ACCOUNT_PENDING', sourceId: CANCELLATION, category: 'REFUND', createdAt: new Date(NOW).toISOString() });
  });

  test('P-T72 ⑤ 2xx 밖(401·409·500)은 던진다(연 시각을 쓰지 않게)', async () => {
    for (const status of [401, 409, 500]) {
      const notice = new HttpRefundAccountNotice({ request: async () => new Response('{}', { status }) } as never, 'it-token');
      await expect(notice.open({ cancellationId: CANCELLATION, orderId: 'o', nowMs: NOW }), String(status)).rejects.toThrow();
    }
  });
});

describe('P-T72 시작 조립(글 읽기, 자주 놓친 결함 \'시작 파일 조립\')', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  test('P-T72 start.ts는 견적·팬 취소의 결제 수단 읽기에 payment-svc gRPC 어댑터(refundPayments)를 꽂고 차단기 payment-svc-get(depositBreaker)을 묶는다', () => {
    const start = read('../src/start.ts');
    expect(start).toMatch(/paymentMethods:\s*refundPayments/);
    expect(start).toMatch(/refundPayments\??\.useMethodBreaker\(depositBreaker\)/);
  });
  test('P-T72 relay-app.ts는 ops 주소가 있으면 마감 뒤 환급 실행기에 HttpRefundAccountNotice를 내부 토큰과 함께 꽂는다', () => {
    expect(read('../src/relay-app.ts')).toMatch(/accountNotice:\s*new HttpRefundAccountNotice\(opsClient,\s*o\.env\?\.PEAKET_INTERNAL_TOKEN\)/);
  });
});
