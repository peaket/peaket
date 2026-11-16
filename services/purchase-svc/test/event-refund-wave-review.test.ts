// BAT-420 웨이브 끝 리뷰 반영 purchase-svc 단위 몫(시험 담당, 구현 전에 씀, 계획 §11 보충 4 1a614548):
// K1 항목 FAILED 때 취소 행 표시(같은 트랜잭션), K2 잡기를 잃은 쪽의 끝내기, C2·S1 차액·이상 표시 건을 행마다 다시 열기·2xx만 연 것·운영 시작 검사.
// 두 길의 동시·차례 경합(K1·K2)은 실제 SQL이 필요해 test-int(cancellation·event-cancel-r-t24·event-refund)가 본다.
// 정본: docs/features/transfer-refund.md §3.1 ②, §5 '일괄 환불 항목의 주인과 겹침 막기'·'그래도 남는 건'. 시험 담당이 구현 전에 썼다(ADR-0270).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import type { EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';
import type { CsCaseOutbox, EventRefundClaims, EventRefundFailureNotice } from '../src/modules/refund/domain/event-refund-ports.js';
import { EVENT_REFUND_CLAIM_MS, HttpDeductionGapNotice, HttpEntryFlagNotice, MemoryEventRefundAttemptStore, RefundAfterEntry } from '../src/modules/refund/index.js';
import { requireOpsInternalToken } from '../src/refund-wiring.js';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const REQUEST = '0194c800-0000-7000-8000-000000000001';
const EVENT = '0194c800-0000-7000-8000-000000000002';
const ORDER = '0194c800-0000-7000-8000-000000000003';
const TICKET = '0194c800-0000-7000-8000-000000000004';
const target = (over: Partial<EventRefundTarget> = {}): EventRefundTarget => ({
  orderId: ORDER,
  ticketId: TICKET,
  seatId: '0194c800-0000-7000-8000-000000000005',
  payerAccountId: '0194c800-0000-7000-8000-000000000006',
  ticketPrice: 33_333,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 7 * 86_400_000,
  pg: 'TOSS',
  ...over,
});
const startOf = (s: EventRefundService) => s.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2', fanNoticeReason: '공연 취소' });
type GapOpen = Parameters<NonNullable<ConstructorParameters<typeof EventRefundService>[0]['gapNotice']>['open']>[0];

describe('항목 FAILED 때 취소 행 표시 [BAT-420 웨이브 끝 리뷰 K1]', () => {
  test('GAT-110 K1 항목이 실패로 끝나면 끝내기와 같은 저장(updateItem)에 그 취소 행의 refund_failed_at 표시(cancellationFailure)를 싣고, 환급되면 싣지 않는다', async () => {
    const store = new MemoryEventRefundStore();
    const extras: { status: string; extra: unknown }[] = [];
    const real = store.updateItem.bind(store);
    store.updateItem = async (item, outbox, extra) => (extras.push({ status: item.status, extra }), real(item, outbox));
    const service = new EventRefundService({
      store,
      targets: { list: async () => [target(), target({ ticketId: '0194c800-0000-7000-8000-0000000000a2', orderId: '0194c800-0000-7000-8000-0000000000a3' })] },
      canceller: { cancel: async (t) => (t.ticketId === TICKET ? { status: 'FAILED', error: 'REJECTED' } : { status: 'REFUNDED' }) },
      notice: { open: async () => undefined },
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    await startOf(service);
    const failed = extras.filter((e) => e.status === 'FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.extra).toMatchObject({ cancellationFailure: { lastError: 'REJECTED' } });
    for (const e of extras.filter((x) => x.status === 'REFUNDED')) expect((e.extra as { cancellationFailure?: unknown } | undefined)?.cancellationFailure).toBeUndefined();
  });
});

describe('잡기를 잃은 쪽의 끝내기 [BAT-420 웨이브 끝 리뷰 K2]', () => {
  test('GAT-110 K2 잡기 기한은 60,000ms [가정]이다', () => {
    expect(EVENT_REFUND_CLAIM_MS).toBe(60_000);
  });

  test('GAT-110 K2 잡기를 잃어 끝내기가 0행(false)이면 경고 event-refund-item-claim-lost 한 번이고 CS 건·시도 기록·저장소 끝내기를 남기지 않는다', async () => {
    const store = new MemoryEventRefundStore();
    let storeFinishes = 0;
    const real = store.updateItem.bind(store);
    store.updateItem = async (item, outbox, extra) => (storeFinishes++, real(item, outbox, extra));
    const claimCalls: [string, number][] = [];
    const finishes: Parameters<EventRefundClaims['finish']>[0][] = [];
    const claims: EventRefundClaims = {
      claimOrders: async (requestId, nowMs) => {
        claimCalls.push([requestId, nowMs]);
        return { claimToken: 'tok-1', items: (await store.items(requestId)).filter((i) => i.status === 'PENDING') };
      },
      finish: async (q) => (finishes.push(q), false),
      release: async () => undefined,
    };
    const notices: Parameters<EventRefundFailureNotice['open']>[0][] = [];
    const attempts = new MemoryEventRefundAttemptStore();
    const warns: { o: object; msg: string }[] = [];
    let cancels = 0;
    const service = new EventRefundService({
      store,
      targets: { list: async () => [target()] },
      canceller: { cancel: async () => (cancels++, { status: 'FAILED', error: 'REJECTED' }) },
      notice: { open: async (q) => void notices.push(q) },
      attempts,
      claims,
      log: { warn: (o, msg) => void warns.push({ o, msg }) },
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    await startOf(service);
    expect(claimCalls[0]).toEqual([REQUEST, NOW]);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ requestId: REQUEST, ticketId: TICKET, claimToken: 'tok-1', status: 'FAILED' });
    expect(warns.filter((w) => JSON.stringify(w).includes('event-refund-item-claim-lost'))).toHaveLength(1);
    expect(notices).toEqual([]);
    expect(attempts.attempts).toEqual([]);
    expect(storeFinishes).toBe(0);
    expect(cancels).toBe(1);
  });
});

describe('차액 건 행마다 다시 열기 [BAT-420 웨이브 끝 리뷰 C2·S1]', () => {
  const gapRow = (n: number) => ({ cancellationId: `0194c800-0000-7000-8000-00000000c00${n}`, orderId: ORDER, deductionAmount: 3_333 * n, requestId: REQUEST });
  const outboxOf = (rows: ReturnType<typeof gapRow>[]) => {
    const opened = new Map<string, number>();
    const limits: number[] = [];
    const outbox: Pick<CsCaseOutbox, 'pendingGaps' | 'markGapOpened'> = {
      pendingGaps: async (limit) => (limits.push(limit), rows.filter((r) => !opened.has(r.cancellationId))),
      markGapOpened: async (id, nowMs) => void opened.set(id, nowMs),
    };
    return { outbox, opened, limits };
  };

  test('R-T38 ④ runDue는 열지 않은 차액 건을 한 틱에 100건까지 행마다 따로 열고, 한 행이 실패해도 나머지는 열며(경고·지표 하나) 다음 틱에 그 행을 다시 연다', async () => {
    const rows = [gapRow(1), gapRow(2), gapRow(3)];
    const o = outboxOf(rows);
    const sent: GapOpen[] = [];
    let failOnce = true;
    const warns: { o: object; msg: string }[] = [];
    const metric: string[] = [];
    const service = new EventRefundService({
      store: new MemoryEventRefundStore(),
      targets: { list: async () => [] },
      canceller: { cancel: async () => ({ status: 'REFUNDED' }) },
      gapNotice: {
        open: async (q) => {
          if (q.cancellationId === rows[1]!.cancellationId && failOnce) {
            failOnce = false;
            throw new Error('ops 500');
          }
          sent.push(q);
        },
      },
      csOutbox: o.outbox,
      csCaseOpenFailures: { inc: (kind) => void metric.push(kind) },
      log: { warn: (x, msg) => void warns.push({ o: x, msg }) },
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    await service.runDue();
    expect(o.limits[0]).toBe(100);
    expect([...o.opened.keys()].sort()).toEqual([rows[0]!.cancellationId, rows[2]!.cancellationId].sort());
    expect(o.opened.get(rows[0]!.cancellationId)).toBe(NOW);
    expect(warns).toHaveLength(1);
    expect(metric).toEqual(['DEDUCTION_GAP']);
    expect(sent.find((s) => s.cancellationId === rows[0]!.cancellationId)).toEqual({ cancellationId: rows[0]!.cancellationId, orderId: ORDER, deductionAmount: 3_333, requestId: REQUEST, nowMs: NOW });
    await service.runDue();
    expect(o.opened.has(rows[1]!.cancellationId)).toBe(true);
    expect(sent.filter((s) => s.cancellationId === rows[0]!.cancellationId)).toHaveLength(1);
  });

  test('GAT-110 C2 차액 건 열기가 실패해도 이미 FAILED로 끝난 항목을 다시 열지 않는다(시도 기록 0, 취소기 다시 부름 0)', async () => {
    const store = new MemoryEventRefundStore();
    const attempts = new MemoryEventRefundAttemptStore();
    let cancels = 0;
    const o = outboxOf([gapRow(1)]);
    const service = new EventRefundService({
      store,
      targets: { list: async () => [target()] },
      canceller: { cancel: async () => (cancels++, { status: 'FAILED', error: 'cancellation-conflict' }) },
      notice: { open: async () => undefined },
      gapNotice: { open: async () => Promise.reject(new Error('ops down')) },
      csOutbox: o.outbox,
      attempts,
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    await startOf(service);
    const before = attempts.attempts.length;
    await service.runDue();
    await service.runDue();
    const [item] = await store.items(REQUEST);
    expect(item).toMatchObject({ status: 'FAILED', lastError: 'cancellation-conflict' });
    expect(cancels).toBe(1);
    expect(attempts.attempts).toHaveLength(before);
    expect(o.opened.size).toBe(0);
  });
});

describe('CS 어댑터는 2xx만 연 것으로 본다 [BAT-420 웨이브 끝 리뷰 S1]', () => {
  const answering = (status: number | 'timeout') => ({
    request: async () => (status === 'timeout' ? Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })) : new Response('{}', { status })),
  });
  const gapOpen = (n: HttpDeductionGapNotice) => n.open({ cancellationId: randomUUID(), orderId: ORDER, deductionAmount: 3_333, requestId: REQUEST, nowMs: NOW });
  const flagOpen = (n: HttpEntryFlagNotice) => n.open({ cancellationId: randomUUID(), orderId: ORDER, ticketId: TICKET, enteredAtMs: NOW - 60_000, nowMs: NOW });

  test.each([401, 500, 'timeout'] as const)('R-T38 ④ 차액·이상 표시 어댑터는 %s이면 던진다', async (status) => {
    await expect(gapOpen(new HttpDeductionGapNotice(answering(status), 'it-token'))).rejects.toThrow();
    await expect(flagOpen(new HttpEntryFlagNotice(answering(status), 'it-token'))).rejects.toThrow();
  });

  test('R-T38 ④ 차액·이상 표시 어댑터는 202면 성공이다(대조)', async () => {
    await expect(gapOpen(new HttpDeductionGapNotice(answering(202), 'it-token'))).resolves.toBeUndefined();
    await expect(flagOpen(new HttpEntryFlagNotice(answering(202), 'it-token'))).resolves.toBeUndefined();
  });

  test('R-T38 ④ 환급 실행기는 열지 않은 이상 표시 건을 틱마다 다시 열고, 실패하면 연 시각을 쓰지 않고(지표 하나) 다음 틱에 연다', async () => {
    const row = { cancellationId: randomUUID(), orderId: ORDER, ticketId: TICKET, enteredAtMs: NOW - 60_000 };
    const opened = new Map<string, number>();
    const limits: number[] = [];
    let fail = true;
    const metric: string[] = [];
    const runner = new RefundAfterEntry({
      nowMs: () => NOW,
      writes: { dueRefunds: async () => [] } as never,
      payments: { cancel: async () => 'CANCELLED' },
      entries: { lookup: async () => new Map() },
      claims: { claimDue: async () => true, markEntryRecorded: async () => true },
      flags: {
        open: async () => {
          if (fail) {
            fail = false;
            throw new Error('ops 401');
          }
        },
      },
      csOutbox: {
        pendingFlags: async (limit) => (limits.push(limit), opened.has(row.cancellationId) ? [] : [row]),
        markFlagOpened: async (id, nowMs) => void opened.set(id, nowMs),
      },
      csCaseOpenFailures: { inc: (kind) => void metric.push(kind) },
      log: { warn: () => undefined, error: () => undefined },
    });
    await runner.run();
    expect(limits[0]).toBe(100);
    expect(opened.size).toBe(0);
    expect(metric).toEqual(['FLAGGED']);
    await runner.run();
    expect(opened.get(row.cancellationId)).toBe(NOW);
  });
});

describe('운영 시작 검사 [BAT-420 웨이브 끝 리뷰 S1]', () => {
  test('GAT-110 S1 운영에서 ops 주소가 있고 내부 토큰이 없으면 시작하지 않고, ci는 경고 한 번이며, 토큰이 있거나 ops 주소가 없으면 그대로다', () => {
    const ops = 'http://ops-svc:8080';
    expect(() => requireOpsInternalToken({ env: { PEAKET_ENV: 'production', PEAKET_OPS_HTTP_URL: ops } })).toThrow();
    expect(() => requireOpsInternalToken({ env: { PEAKET_ENV: 'staging', PEAKET_OPS_HTTP_URL: ops } })).toThrow();
    expect(() => requireOpsInternalToken({ env: { PEAKET_OPS_HTTP_URL: ops } })).toThrow();
    expect(() => requireOpsInternalToken({ env: { PEAKET_ENV: 'production', PEAKET_OPS_HTTP_URL: ops, PEAKET_INTERNAL_TOKEN: 'tok' } })).not.toThrow();
    expect(() => requireOpsInternalToken({ env: { PEAKET_ENV: 'production' } })).not.toThrow();
    const warns: string[] = [];
    expect(() => requireOpsInternalToken({ env: { PEAKET_ENV: 'ci', PEAKET_OPS_HTTP_URL: ops }, warn: (m) => void warns.push(m) })).not.toThrow();
    expect(warns).toHaveLength(1);
  });

  test('GAT-110 S1 relay-app.ts·start.ts는 시작 때 requireOpsInternalToken을 부른다', () => {
    for (const file of ['relay-app.ts', 'start.ts']) {
      const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      expect(text, file).toContain('requireOpsInternalToken(');
    }
  });

  test('GAT-110 K2 start.ts·relay-app.ts의 일괄 환불은 잡기(claims)와 CS 건 다시 열기(csOutbox)를 꽂는다', () => {
    for (const file of ['relay-app.ts', 'start.ts']) {
      const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(text, file).toContain('new DrizzleEventRefundClaims(');
      expect(text, file).toContain('new DrizzleCsCaseOutbox(');
      const block = text.slice(text.indexOf('new EventRefundService('), text.indexOf('new EventRefundService(') + 2_000);
      expect(block, file).toMatch(/\bclaims\s*[:,}]/);
      expect(block, file).toMatch(/\bcsOutbox\s*[:,}]/);
    }
  });
});
