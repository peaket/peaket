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
import type { CsCaseOutbox, EventRefundClaims, EventRefundFailureNotice, EventRefundStore } from '../src/modules/refund/domain/event-refund-ports.js';
import { EVENT_REFUND_CLAIM_MS, HttpDeductionGapNotice, HttpEntryFlagNotice, MemoryEventRefundAttemptStore, RefundAfterEntry } from '../src/modules/refund/index.js';
import { requireOpsInternalToken } from '../src/refund-wiring.js';
// 다시 보기 2 N1·N2(시험 담당 l3w8-420-n-test, 2026-11-17, 계획 §11 보충 5)
import { eventRefundCancellationId, progressOf, type EventRefundItem } from '../src/modules/refund/domain/event-refund.js';
import { CS_CASE_REOPEN_BUDGET_MS, CS_CASE_REOPEN_MAX_UNREACHABLE, CsCaseRejected, CsCaseReopenBudget, HttpRefundFailureNotice } from '../src/modules/refund/index.js';

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
    // 다시 보기 2 N2(2026-11-17): 다시 열기 포트에 일괄 환불 실패 건 둘이 더해졌다. 이 묶음은 차액 건만 보므로 빈 목록이다
    const outbox: Pick<CsCaseOutbox, 'pendingGaps' | 'markGapOpened' | 'pendingItemFailures' | 'markItemFailureOpened'> = {
      pendingGaps: async (limit) => (limits.push(limit), rows.filter((r) => !opened.has(r.cancellationId))),
      markGapOpened: async (id, nowMs) => void opened.set(id, nowMs),
      pendingItemFailures: async () => [],
      markItemFailureOpened: async () => undefined,
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

  // 다시 보기 2 N2(시험 담당 l3w8-420-n-test, 2026-11-17): 환급 실패 어댑터도 다른 둘과 같이 2xx만 연 것이다
  test('GAT-110 N2 환급 실패 어댑터는 2xx가 아니거나 연결 실패·시간 초과면 던진다', async () => {
    const sent: { path: string; token: string | null; body: unknown }[] = [];
    const client = (answer: number | Error) => ({
      request: async (r: { path: string; headers?: Record<string, string>; body?: unknown }) => {
        sent.push({ path: r.path, token: new Headers(r.headers).get('x-peaket-internal-token'), body: JSON.parse(String(r.body)) });
        if (answer instanceof Error) throw answer;
        return new Response('{}', { status: answer });
      },
    });
    const open = (n: HttpRefundFailureNotice, cancellationId: string) => n.open({ cancellationId, orderId: ORDER, attempts: 5, lastError: 'REJECTED', nowMs: NOW });
    const envToken = process.env.PEAKET_INTERNAL_TOKEN;
    process.env.PEAKET_INTERNAL_TOKEN = 'env-token-not-used';
    try {
      for (const status of [401, 400, 500]) {
        const err = await open(new HttpRefundFailureNotice(client(status), 'it-token'), randomUUID()).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err, String(status)).toBeInstanceOf(CsCaseRejected);
        expect(err, String(status)).toMatchObject({ kind: 'refund-failed', status });
      }
      const refused = connError();
      await expect(open(new HttpRefundFailureNotice(client(refused), 'it-token'), randomUUID())).rejects.toBe(refused);
      const timeout = timeoutError();
      await expect(open(new HttpRefundFailureNotice(client(timeout), 'it-token'), randomUUID())).rejects.toBe(timeout);
      sent.length = 0;
      const id = randomUUID();
      await expect(open(new HttpRefundFailureNotice(client(202), 'it-token'), id)).resolves.toBeUndefined();
      expect(sent).toEqual([
        { path: '/internal/v1/cs-cases', token: 'it-token', body: { eventKey: id, kind: 'REFUND_FAILED', sourceId: id, category: 'REFUND', createdAt: new Date(NOW).toISOString() } },
      ]);
    } finally {
      if (envToken === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
      else process.env.PEAKET_INTERNAL_TOKEN = envToken;
    }
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
        // 다시 보기 2 N2(2026-11-17): 환급 실패 건 둘이 더해졌다. 이 시험은 이상 표시만 보므로 빈 목록이다
        pendingRefundFailures: async () => [],
        markRefundFailureOpened: async () => undefined,
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

  // 다시 보기 2 N2(시험 담당 l3w8-420-n-test): 환급 실패 어댑터도 내부 토큰을 생성자로 받는다(다른 두 CS 어댑터와 같게, process.env를 읽지 않음)
  test('GAT-110 N2 start.ts·relay-app.ts는 환급 실패 어댑터(HttpRefundFailureNotice)를 만들 때마다 내부 토큰을 둘째 인자로 넘긴다', () => {
    /** `new HttpRefundFailureNotice(` 뒤 괄호 짝이 맞는 인자 목록에서 맨 바깥 쉼표가 있는지 */
    const hasSecondArg = (text: string, at: number): boolean => {
      let depth = 0;
      for (let i = at; i < text.length; i++) {
        const ch = text[i]!;
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) return false;
        } else if (ch === ',' && depth === 1) return /\S/.test(text.slice(i + 1, text.indexOf(')', i + 1)));
      }
      return false;
    };
    for (const file of ['relay-app.ts', 'start.ts']) {
      const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      const marker = 'new HttpRefundFailureNotice(';
      const starts = [...text.matchAll(/new HttpRefundFailureNotice\(/g)].map((m) => m.index! + marker.length - 1);
      expect(starts.length, file).toBeGreaterThan(0);
      for (const at of starts) expect(hasSecondArg(text, at), `${file}@${at}`).toBe(true);
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

// ---- BAT-420 다시 보기 2 N1·N2(시험 담당 l3w8-420-n-test, 구현 전에 씀, 계획 §11 보충 5 bb70a744) ----
// 정본: docs/features/transfer-refund.md §3.1 ⑥ 'CS 건 열기와 다시 열기'·§5 '주인', docs/api/guidelines.md §8.1 'ops-svc CS 처리함 내부 HTTP'.
// 시계는 가짜다: ops 대역이 부를 때마다 가짜 시간을 밀어 무응답(5,000ms 뒤 시간 초과)·지연(4,000ms 뒤 202)을 만든다. 실제 시계·HTTP는 test-int(event-refund·cancellation)가 본다.
type Clock = { t: number };
type OpsAnswer = 'hang' | 'conn' | 202 | 400 | 401 | 500 | { readonly slowMs: number };
const uuidOf = (n: number) => `0194c800-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const connError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

/** ops 대역: 부를 때마다 차례 기록에 'ops:…'를 남긴다. queue를 먼저 쓰고, 비면 mode다 */
function opsDouble(clock: Clock, log: string[]) {
  const d = {
    mode: 'hang' as OpsAnswer,
    queue: [] as OpsAnswer[],
    async call(label: string): Promise<void> {
      log.push(`ops:${label}`);
      const a = d.queue.length > 0 ? d.queue.shift()! : d.mode;
      if (a === 'hang') {
        clock.t += 5_000;
        throw timeoutError();
      }
      if (a === 'conn') throw connError();
      if (typeof a === 'object') {
        clock.t += a.slowMs;
        return;
      }
      if (a !== 202) throw new CsCaseRejected('refund-failed', a);
    },
  };
  return d;
}
const opsCalls = (log: readonly string[]) => log.filter((l) => l.startsWith('ops:'));
/** 결제사 호출이 하나 이상 있고 모든 결제사 호출이 첫 ops 호출보다 앞이다 */
const paysBeforeOps = (log: readonly string[]) => {
  const lastPay = log.reduce((at, l, i) => (l.startsWith('pay:') ? i : at), -1);
  const firstOps = log.findIndex((l) => l.startsWith('ops:'));
  return lastPay >= 0 && (firstOps === -1 || firstOps > lastPay);
};
const named = (warns: readonly { o: object; msg: string }[], name: string) => warns.filter((w) => JSON.stringify(w).includes(name));

const failureRow = (n: number) => ({ requestId: REQUEST, orderId: uuidOf(0x1000 + n), ticketId: uuidOf(0x2000 + n), cancellationId: uuidOf(0x3000 + n), attempts: 1, lastError: 'REJECTED' });
const gapRowOf = (n: number) => ({ cancellationId: uuidOf(0x4000 + n), orderId: uuidOf(0x5000 + n), deductionAmount: 3_333, requestId: REQUEST });
type ReopenBox = Pick<CsCaseOutbox, 'pendingGaps' | 'markGapOpened' | 'pendingItemFailures' | 'markItemFailureOpened'>;

/** 열지 않은 일괄 환불 실패 건·차액 건 목록 대역(연 시각은 mark를 부른 것만) */
function reopenOutbox(itemFailures: readonly ReturnType<typeof failureRow>[], gaps: readonly ReturnType<typeof gapRowOf>[]) {
  const itemOpened = new Map<string, number>();
  const gapOpened = new Map<string, number>();
  const outbox: ReopenBox = {
    pendingItemFailures: async (limit) => itemFailures.filter((r) => !itemOpened.has(`${r.requestId}/${r.ticketId}`)).slice(0, limit),
    markItemFailureOpened: async (requestId, ticketId, nowMs) => void itemOpened.set(`${requestId}/${ticketId}`, nowMs),
    pendingGaps: async (limit) => gaps.filter((r) => !gapOpened.has(r.cancellationId)).slice(0, limit),
    markGapOpened: async (id, nowMs) => void gapOpened.set(id, nowMs),
  };
  return { outbox, itemOpened, gapOpened };
}

type ItemExtra = Parameters<EventRefundStore['updateItem']>[2];
/** 메모리 저장소의 항목 쓰기를 엿본다(끝내기와 같은 저장에 실은 표시 extra) */
function captureWrites(store: MemoryEventRefundStore) {
  const writes: { item: EventRefundItem; extra: ItemExtra }[] = [];
  const real = store.updateItem.bind(store);
  store.updateItem = async (item, outbox, extra?: ItemExtra) => (writes.push({ item, extra }), real(item, outbox, extra));
  return writes;
}
/** 저장소가 받은 표시로 만든 다시 열기 포트 대역: 일괄 환불 실패는 failureCase를 실은 FAILED 쓰기, 차액은 저장소의 차액 표시 */
function storeOutbox(store: MemoryEventRefundStore, writes: ReturnType<typeof captureWrites>) {
  const itemOpened = new Map<string, number>();
  const gapOpened = new Map<string, number>();
  const outbox: ReopenBox = {
    pendingItemFailures: async (limit) =>
      writes
        .filter((w) => w.item.status === 'FAILED' && w.extra?.failureCase === true && !itemOpened.has(`${w.item.requestId}/${w.item.ticketId}`))
        .slice(0, limit)
        .map((w) => ({ requestId: w.item.requestId, orderId: w.item.orderId, ticketId: w.item.ticketId, cancellationId: w.item.cancellationId, attempts: w.item.attempts, lastError: w.item.lastError ?? 'failed' })),
    markItemFailureOpened: async (requestId, ticketId, nowMs) => void itemOpened.set(`${requestId}/${ticketId}`, nowMs),
    pendingGaps: async (limit) =>
      [...store.deductionGaps.entries()]
        .filter(([id]) => !gapOpened.has(id))
        .slice(0, limit)
        .map(([cancellationId, requestId]) => ({ cancellationId, orderId: ORDER, deductionAmount: 3_333, requestId })),
    markGapOpened: async (id, nowMs) => void gapOpened.set(id, nowMs),
  };
  return { outbox, itemOpened, gapOpened };
}

/** 실행 중(RUNNING) 요청 하나와 지금 처리할 PENDING 항목(표마다 주문 하나)을 넣고 그 대상 표를 준다 */
async function seedRunning(store: MemoryEventRefundStore, requestId: string, eventId: string, nowMs: number, overs: readonly Partial<EventRefundItem>[]): Promise<EventRefundTarget[]> {
  const targets = overs.map(() => target({ orderId: randomUUID(), ticketId: randomUUID() }));
  const items: EventRefundItem[] = targets.map((t, i) => ({
    requestId,
    orderId: t.orderId,
    ticketId: t.ticketId,
    cancellationId: eventRefundCancellationId(requestId, t.ticketId),
    pg: 'TOSS',
    status: 'PENDING',
    attempts: 0,
    appliedAtMs: nowMs,
    nextAttemptAtMs: nowMs,
    ...overs[i],
  }));
  await store.create(
    {
      requestId,
      eventId,
      kind: 'CANCEL',
      status: 'RUNNING',
      fault: 'ORGANIZER',
      targetOrders: items.length,
      refundTotal: items.length * 33_333,
      compensationTargets: 0,
      compensationTotal: 0,
      progress: progressOf(items, [], false),
      ruledBy: 'commander-1',
      confirmedBy: 'operator-2',
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    },
    items,
  );
  return targets;
}

/** 다시 열기 포트를 꽂은 일괄 환불 실행기(결제사는 늘 환급). 일괄 환불 실패 건은 notice, 차액 건은 gapNotice로 ops 대역을 부른다 */
function reopenService(o: { clock: Clock; log: string[]; ops: ReturnType<typeof opsDouble>; outbox: ReopenBox }) {
  const store = new MemoryEventRefundStore();
  const targetsByEvent = new Map<string, EventRefundTarget[]>();
  const metric: string[] = [];
  const cuts: string[] = [];
  const warns: { o: object; msg: string }[] = [];
  const service = new EventRefundService({
    store,
    targets: { list: async (eventId) => targetsByEvent.get(eventId) ?? [] },
    canceller: { cancel: async (t) => (o.log.push(`pay:${t.ticketId}`), { status: 'REFUNDED' }) },
    notice: { open: (q) => o.ops.call(`fail:${q.cancellationId}`) },
    gapNotice: { open: (q) => o.ops.call(`gap:${q.cancellationId}`) },
    csOutbox: o.outbox,
    csCaseOpenFailures: { inc: (kind) => void metric.push(kind), cut: (reason) => void cuts.push(reason) },
    log: { warn: (x, msg) => void warns.push({ o: x, msg }) },
    nowMs: () => o.clock.t,
    deadlineMs: () => o.clock.t + 5_000,
  });
  return { service, store, targetsByEvent, metric, cuts, warns };
}

describe('CS 건 다시 열기는 틱 끝에서 시간 예산 안에만 [BAT-420 다시 보기 2 N1]', () => {
  test('GAT-110 N1 ops-svc가 답하지 않아도 일괄 환불 틱은 결제사를 먼저 부르고 다시 열기는 시간 초과 두 번에서 멈춘다', async () => {
    const clock: Clock = { t: NOW };
    const log: string[] = [];
    const ops = opsDouble(clock, log);
    const box = reopenOutbox(
      Array.from({ length: 30 }, (_, i) => failureRow(i)),
      Array.from({ length: 30 }, (_, i) => gapRowOf(i)),
    );
    const r = reopenService({ clock, log, ops, outbox: box.outbox });
    r.targetsByEvent.set(EVENT, await seedRunning(r.store, REQUEST, EVENT, NOW, [{}, {}]));
    const before = clock.t;
    await r.service.runDue();
    // 장애 주입이 실제로 끼어들었는지 먼저: ops를 불렀고 가짜 시간이 밀렸다
    expect(opsCalls(log)).toHaveLength(2);
    expect(clock.t - before).toBeGreaterThan(0);
    expect(log.filter((l) => l.startsWith('pay:'))).toHaveLength(2);
    expect(paysBeforeOps(log)).toBe(true);
    expect(clock.t - before).toBeLessThanOrEqual(10_000);
    const cut = named(r.warns, 'cs-case-reopen-cut');
    expect(cut).toHaveLength(1);
    expect(JSON.stringify(cut[0])).toContain('unreachable');
    expect(r.cuts).toEqual(['unreachable']);
    // 차례는 일괄 환불 실패 → 차액이라 멈추기 전 둘은 일괄 환불 실패 건이다
    expect(r.metric).toEqual(['EVENT_REFUND_FAILED', 'EVENT_REFUND_FAILED']);
    expect(box.itemOpened.size + box.gapOpened.size).toBe(0);
    // 다음 틱에 ops가 바로 202면 60건(종류마다 100건 한도 안) 모두 열린다
    ops.mode = 202;
    await r.service.runDue();
    expect(box.itemOpened.size).toBe(30);
    expect(box.gapOpened.size).toBe(30);
    expect(r.cuts).toEqual(['unreachable']);
  });

  test('GAT-110 N1 ops-svc가 느리게(4초) 답하면 한 틱의 다시 열기는 5초 예산에서 멈추고 남은 건은 다음 틱이다', async () => {
    const clock: Clock = { t: NOW };
    const log: string[] = [];
    const ops = opsDouble(clock, log);
    ops.mode = { slowMs: 4_000 };
    // 열지 않은 건 다섯(일괄 환불 실패 셋·차액 둘). 예산은 그 틱의 모든 종류가 함께 쓴다
    const failures = [failureRow(1), failureRow(2), failureRow(3)];
    const box = reopenOutbox(failures, [gapRowOf(1), gapRowOf(2)]);
    const r = reopenService({ clock, log, ops, outbox: box.outbox });
    const perTick: number[] = [];
    for (let tick = 0; tick < 3; tick++) {
      // 틱마다 처리할 항목 하나(다른 회차의 새 요청)를 넣어 결제사 호출이 다시 열기보다 앞인지 본다
      const eventId = randomUUID();
      r.targetsByEvent.set(eventId, await seedRunning(r.store, randomUUID(), eventId, clock.t, [{}]));
      const from = log.length;
      await r.service.runDue();
      const slice = log.slice(from);
      expect(slice.filter((l) => l.startsWith('pay:')), `tick ${tick}`).toHaveLength(1);
      expect(paysBeforeOps(slice), `tick ${tick}`).toBe(true);
      perTick.push(box.itemOpened.size + box.gapOpened.size);
    }
    expect(perTick).toEqual([2, 4, 5]);
    expect(r.cuts).toEqual(['budget', 'budget']);
    expect(named(r.warns, 'cs-case-reopen-cut')).toHaveLength(2);
    expect(opsCalls(log).slice(0, 2)).toEqual([`ops:fail:${failures[0]!.cancellationId}`, `ops:fail:${failures[1]!.cancellationId}`]);

    // 예산 경계: 남은 예산이 1ms면 부르고(4,999ms 뒤 둘째 호출) 0ms면 부르지 않는다(5,000ms 뒤 멈춤)
    for (const [slowMs, expected] of [
      [4_999, 2],
      [5_000, 1],
    ] as const) {
      const c: Clock = { t: NOW };
      const l: string[] = [];
      const o2 = opsDouble(c, l);
      o2.mode = { slowMs };
      const b = reopenOutbox([failureRow(7), failureRow(8), failureRow(9)], []);
      await reopenService({ clock: c, log: l, ops: o2, outbox: b.outbox }).service.runDue();
      expect(b.itemOpened.size, `${slowMs}ms`).toBe(expected);
    }
    const c: Clock = { t: 0 };
    const budget = new CsCaseReopenBudget({ nowMs: () => c.t });
    expect(budget.canCall()).toBe(true);
    c.t = CS_CASE_REOPEN_BUDGET_MS - 1;
    expect(budget.canCall()).toBe(true);
    c.t = CS_CASE_REOPEN_BUDGET_MS;
    expect(budget.canCall()).toBe(false);
    expect(budget.cut).toBe('budget');
    expect(CS_CASE_REOPEN_BUDGET_MS).toBe(5_000);
  });

  test('GAT-110 N1 2xx 밖의 답은 잇따른 무응답에 세지 않는다', async () => {
    const run = async (answers: readonly OpsAnswer[]) => {
      const clock: Clock = { t: NOW };
      const log: string[] = [];
      const ops = opsDouble(clock, log);
      ops.queue.push(...answers);
      ops.mode = 202;
      const box = reopenOutbox(
        answers.map((_, i) => failureRow(20 + i)),
        [],
      );
      const r = reopenService({ clock, log, ops, outbox: box.outbox });
      await r.service.runDue();
      return { calls: opsCalls(log).length, opened: box.itemOpened.size, failures: r.metric.length, cuts: r.cuts };
    };
    expect(await run([401, 'conn', 401, 'conn', 202])).toEqual({ calls: 5, opened: 1, failures: 4, cuts: [] });
    // 대조: 연결 실패가 두 번 잇따르면 거기서 멈춘다
    expect(await run(['conn', 'conn', 202])).toEqual({ calls: 2, opened: 0, failures: 2, cuts: ['unreachable'] });
    const b = new CsCaseReopenBudget({ nowMs: () => NOW });
    b.record('unreachable');
    b.record('rejected');
    b.record('unreachable');
    expect(b.canCall()).toBe(true);
    b.record('unreachable');
    expect(b.canCall()).toBe(false);
    expect(b.cut).toBe('unreachable');
    expect(CS_CASE_REOPEN_MAX_UNREACHABLE).toBe(2);
  });

  test('GAT-110 N1 다시 열기 포트가 있으면 처리 중에는 CS를 부르지 않는다', async () => {
    const clock: Clock = { t: NOW };
    const log: string[] = [];
    const ops = opsDouble(clock, log);
    ops.mode = 202;
    const store = new MemoryEventRefundStore();
    const writes = captureWrites(store);
    const box = storeOutbox(store, writes);
    const GAP = uuidOf(0x9001);
    // 전환에서 진 항목(보류 취소를 마감 뒤 환급이 먼저 공제하고 보냄): 그 행이 차액 대상이다
    const lost = target({ ticketId: uuidOf(0x9002), orderId: uuidOf(0x9003), pendingCancellationId: GAP });
    const service = new EventRefundService({
      store,
      targets: { list: async () => [target(), lost] },
      canceller: { cancel: async (t) => (log.push(`pay:${t.ticketId}`), t.ticketId === TICKET ? { status: 'FAILED', error: 'REJECTED' } : { status: 'FAILED', error: 'cancellation-in-progress' }) },
      notice: { open: (q) => ops.call(`fail:${q.cancellationId}`) },
      gaps: { list: async () => [{ cancellationId: GAP, orderId: lost.orderId, ticketId: lost.ticketId, deductionAmount: 3_333 }] },
      gapNotice: { open: (q) => ops.call(`gap:${q.cancellationId}`) },
      configs: { config: async () => ({ saleEndsAtMs: NOW + 7 * 86_400_000, entryOpensAtMs: NOW - 3_600_000 }) },
      csOutbox: box.outbox,
      csCaseOpenFailures: { inc: () => undefined, cut: () => undefined },
      nowMs: () => clock.t,
      deadlineMs: () => clock.t + 5_000,
    });
    // API 파드의 Start(첫 묶음): 거절 항목 하나·전환에서 진 차액 항목 하나
    await startOf(service);
    expect(log.filter((l) => l.startsWith('pay:'))).toHaveLength(2);
    expect(opsCalls(log)).toEqual([]);
    const failed = writes.filter((w) => w.item.status === 'FAILED');
    expect(failed).toHaveLength(2);
    expect(failed.find((w) => w.item.ticketId === TICKET)?.extra).toMatchObject({ failureCase: true, cancellationFailure: { lastError: 'REJECTED' } });
    const lostWrite = failed.find((w) => w.item.ticketId === lost.ticketId);
    expect(lostWrite?.extra).toMatchObject({ deductionGap: { cancellationId: GAP, requestId: REQUEST } });
    expect(lostWrite?.extra?.failureCase).toBeUndefined();
    // 그 뒤 리더 runDue의 틱 끝에서 건 둘(일괄 환불 실패 → 차액 차례)
    await service.runDue();
    expect(opsCalls(log)).toEqual([`ops:fail:${eventRefundCancellationId(REQUEST, TICKET)}`, `ops:gap:${GAP}`]);
    expect(box.itemOpened.size).toBe(1);
    expect(box.gapOpened.get(GAP)).toBe(NOW);
  });
});

describe('일괄 환불 실패 건의 열 대상 표시와 다시 열기 [BAT-420 다시 보기 2 N2]', () => {
  test('GAT-110 N2 일괄 환불 항목이 FAILED로 끝나면 같은 커밋에 열 대상 표시가 남고 틱 끝에 열어 2xx면 연 시각을 쓴다', async () => {
    const clock: Clock = { t: NOW };
    const log: string[] = [];
    const ops = opsDouble(clock, log);
    ops.mode = 500;
    const store = new MemoryEventRefundStore();
    const writes = captureWrites(store);
    const box = storeOutbox(store, writes);
    const metric: string[] = [];
    const warns: { o: object; msg: string }[] = [];
    const targetsByEvent = new Map<string, EventRefundTarget[]>([[EVENT, [target()]]]);
    const cancelAs = new Map<string, { status: 'REFUNDED' | 'REFUND_PENDING' | 'FAILED'; error?: string }>([[TICKET, { status: 'FAILED', error: 'REJECTED' }]]);
    const service = new EventRefundService({
      store,
      targets: { list: async (eventId) => targetsByEvent.get(eventId) ?? [] },
      canceller: { cancel: async (t) => cancelAs.get(t.ticketId) ?? { status: 'REFUNDED' } },
      notice: { open: (q) => ops.call(`fail:${q.cancellationId}`) },
      csOutbox: box.outbox,
      csCaseOpenFailures: { inc: (kind) => void metric.push(kind), cut: () => undefined },
      log: { warn: (x, msg) => void warns.push({ o: x, msg }) },
      nowMs: () => clock.t,
      deadlineMs: () => clock.t + 5_000,
    });
    // 결제사 거절: 항목 FAILED와 열 대상 표시가 같은 저장(updateItem 한 번)이다
    await startOf(service);
    const failed = writes.filter((w) => w.item.status === 'FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.extra).toMatchObject({ failureCase: true, cancellationFailure: { lastError: 'REJECTED' } });
    expect(opsCalls(log)).toEqual([]);
    // 첫 열기 500: 연 시각 빔·경고 하나·지표 하나·항목 FAILED 그대로
    await service.runDue();
    expect(opsCalls(log)).toEqual([`ops:fail:${eventRefundCancellationId(REQUEST, TICKET)}`]);
    expect(box.itemOpened.size).toBe(0);
    expect(named(warns, 'event-refund-failure-notice-failed')).toHaveLength(1);
    expect(metric).toEqual(['EVENT_REFUND_FAILED']);
    expect((await store.items(REQUEST))[0]).toMatchObject({ status: 'FAILED', lastError: 'REJECTED' });
    // 다음 틱 202: 연 시각
    ops.mode = 202;
    clock.t += 10_000;
    await service.runDue();
    expect(box.itemOpened.get(`${REQUEST}/${TICKET}`)).toBe(NOW + 10_000);
    // 그다음 틱: ops 호출 없음
    await service.runDue();
    expect(opsCalls(log)).toHaveLength(2);

    // FAILED로 끝나는 다른 길도 표시 하나씩: 시도 상한(결과 모름 5번째), #retryOrFail의 FAILED 쓰기(그 밖 실패), 즉시 실패(target-not-found)
    const event2 = randomUUID();
    const request2 = randomUUID();
    const [capped, other, missing] = await seedRunning(store, request2, event2, clock.t, [{ attempts: 4, status: 'UNKNOWN' }, {}, {}]);
    targetsByEvent.set(event2, [capped!, other!]);
    cancelAs.set(capped!.ticketId, { status: 'REFUND_PENDING' });
    cancelAs.set(other!.ticketId, { status: 'FAILED', error: 'boom' });
    await service.runDue();
    const ended = writes.filter((w) => w.item.requestId === request2 && w.item.status === 'FAILED');
    expect(ended.map((w) => [w.item.ticketId, w.item.lastError, w.extra?.failureCase]).sort()).toEqual(
      [
        [capped!.ticketId, 'refund-pending', true],
        [other!.ticketId, 'boom', true],
        [missing!.ticketId, 'target-not-found', true],
      ].sort(),
    );
  });

  test('GAT-110 N2 차액 건으로 대신한 항목에는 일괄 환불 실패 건을 열지 않는다', async () => {
    const bodies: { category: string; sourceId: string; kind: string }[] = [];
    const client = { request: async (r: { body?: unknown }) => (bodies.push(JSON.parse(String(r.body))), new Response('{}', { status: 202 })) };
    const store = new MemoryEventRefundStore();
    const writes = captureWrites(store);
    const box = storeOutbox(store, writes);
    const GAP = uuidOf(0x9101);
    const lost = target({ pendingCancellationId: GAP });
    const service = new EventRefundService({
      store,
      targets: { list: async () => [lost] },
      canceller: { cancel: async () => ({ status: 'FAILED', error: 'cancellation-in-progress' }) },
      notice: new HttpRefundFailureNotice(client, 'it-token'),
      gaps: { list: async () => [{ cancellationId: GAP, orderId: ORDER, ticketId: TICKET, deductionAmount: 3_333 }] },
      gapNotice: new HttpDeductionGapNotice(client, 'it-token'),
      configs: { config: async () => ({ saleEndsAtMs: NOW + 7 * 86_400_000, entryOpensAtMs: NOW - 3_600_000 }) },
      csOutbox: box.outbox,
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    await startOf(service);
    const w = writes.find((x) => x.item.status === 'FAILED');
    expect(w?.item.lastError).toBe('cancellation-in-progress');
    expect(w?.extra).toMatchObject({ deductionGap: { cancellationId: GAP } });
    expect(w?.extra?.failureCase).toBeUndefined();
    await service.runDue();
    expect(bodies.filter((b) => b.category === 'DEDUCTION_GAP').map((b) => b.sourceId)).toEqual([GAP]);
    expect(bodies.filter((b) => b.category === 'REFUND')).toEqual([]);
  });

  test('GAT-110 N2 옛 조립(다시 열기 포트 없음)은 처리 중에 한 번 열고 실패하면 경고·지표만 남긴다', async () => {
    const store = new MemoryEventRefundStore();
    const attempts = new MemoryEventRefundAttemptStore();
    const warns: { o: object; msg: string }[] = [];
    const metric: string[] = [];
    let opens = 0;
    const service = new EventRefundService({
      store,
      targets: { list: async () => [target()] },
      canceller: { cancel: async () => ({ status: 'FAILED', error: 'REJECTED' }) },
      notice: {
        open: async () => {
          opens++;
          throw new CsCaseRejected('refund-failed', 500);
        },
      },
      attempts,
      csCaseOpenFailures: { inc: (kind) => void metric.push(kind) },
      log: { warn: (x, msg) => void warns.push({ o: x, msg }) },
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    const view = await startOf(service);
    expect(opens).toBe(1);
    // #finishItem은 참(끝남)이다: 항목 FAILED·진행률 실패 하나·시도 기록(REJECT)이 남는다
    expect((await store.items(REQUEST))[0]).toMatchObject({ status: 'FAILED', lastError: 'REJECTED' });
    expect(view.progress).toMatchObject({ failed: 1 });
    expect(attempts.attempts.map((a) => a.outcome)).toEqual(['REJECT']);
    expect(named(warns, 'event-refund-failure-notice-failed')).toHaveLength(1);
    expect(metric).toEqual(['EVENT_REFUND_FAILED']);

    // 마감 뒤 환급 실행기의 옛 조립: 환급 실패 건 열기가 던져도 run은 던지지 않고 다음 행을 처리한다
    const pays: string[] = [];
    const marks: string[] = [];
    const rwarns: { o: object; msg: string }[] = [];
    const rmetric: string[] = [];
    let notices = 0;
    const row = (id: string) => ({ cancellationId: id, orderId: `o-${id}`, ticketId: `t-${id}`, amount: 7_000, reason: 'USER', status: 'REFUND_PENDING', attempts: 0 });
    const runner = new RefundAfterEntry({
      nowMs: () => NOW,
      writes: {
        dueRefunds: async () => [row('c-1'), row('c-2')],
        updateStatus: async () => true,
        scheduleRefundRetry: async () => true,
        markRefundFailed: async (q: { cancellationId: string }) => (marks.push(q.cancellationId), true),
      } as never,
      payments: { cancel: async (q) => (pays.push(q.cancellationId), 'REJECTED') },
      entries: { lookup: async () => new Map() },
      claims: { claimDue: async () => true, markEntryRecorded: async () => true },
      failureNotice: {
        open: async () => {
          notices++;
          if (notices === 1) throw connError();
        },
      },
      csCaseOpenFailures: { inc: (kind) => void rmetric.push(kind) },
      log: { warn: (x, msg) => void rwarns.push({ o: x, msg }), error: () => undefined },
    });
    await expect(runner.run()).resolves.toMatchObject({ failed: 2 });
    expect(pays).toEqual(['c-1', 'c-2']);
    expect(marks).toEqual(['c-1', 'c-2']);
    expect(notices).toBe(2);
    expect(named(rwarns, 'cancellation-refund-failure-notice-failed')).toHaveLength(1);
    expect(rmetric).toEqual(['REFUND_FAILED']);
  });
});
