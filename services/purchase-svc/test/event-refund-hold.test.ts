// 회차 취소 요청 중 보류 취소의 환급 미룸, purchase-svc 쪽 단위 시험(BAT-420 몫 D, OPEN[45] 결정, R-T38 ⑤, GAT-110 D3,
// docs/features/transfer-refund.md §5 '회차 취소 요청 중 보류 취소의 환급 미룸', refund.proto SetEventRefundHold, asyncapi CaseRequested DEDUCTION_GAP).
// 미룸 저장소의 SQL(같은 회차 다른 요청 ALREADY_EXISTS·기한 비교·조건부 풀기)은 test-int가 본다. 시험 담당이 구현 전에 썼다(ADR-0270).
import { createHash, randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER, type ExternalRequest } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startPurchaseGrpcServer } from '../src/grpc-server.js';
import {
  EventRefundGrpcController,
  EventRefundHoldError,
  EventRefundService,
  HttpDeductionGapNotice,
  MemoryEventRefundStore,
  RefundAfterEntry,
  eventRefundPackage,
  parseEventRefundHold,
  type EventRefundHoldInput,
  type EventRefundHolds,
} from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-20T10:00:00+09:00');
const EVENT = '0194c600-0000-7000-8000-000000000001';
const REQUEST = '0194c600-0000-7000-8000-000000000002';
const SEVEN_DAYS = 604_800_000;

const hold = (over: Partial<EventRefundHoldInput> = {}): EventRefundHoldInput => ({ eventId: EVENT, cancellationRequestId: REQUEST, held: true, expiresAtMs: NOW + 259_200_000, nowMs: NOW, ...over });
const invalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof EventRefundHoldError && e.code === 'INVALID';
  }
  return false;
};

describe('미룸 입력 검사 [BAT-420 몫 D]', () => {
  test('GAT-110 D3 걸기 기한은 지금보다 늦고 지금 + 604,800,000ms(7일)까지다(경계 양쪽)', () => {
    expect(parseEventRefundHold(hold({ expiresAtMs: NOW + SEVEN_DAYS }))).toMatchObject({ expiresAtMs: NOW + SEVEN_DAYS, held: true });
    expect(parseEventRefundHold(hold({ expiresAtMs: NOW + 1 }))).toMatchObject({ expiresAtMs: NOW + 1 });
    expect(invalid(() => parseEventRefundHold(hold({ expiresAtMs: NOW + SEVEN_DAYS + 1 })))).toBe(true);
    expect(invalid(() => parseEventRefundHold(hold({ expiresAtMs: NOW })))).toBe(true);
    expect(invalid(() => parseEventRefundHold(hold({ expiresAtMs: NOW - 1 })))).toBe(true);
    const { expiresAtMs: _drop, ...noExpiry } = hold();
    expect(invalid(() => parseEventRefundHold(noExpiry))).toBe(true);
  });

  test('GAT-110 D3 풀기는 기한 없이 받고, 회차·요청 ID는 소문자 UUID만 받는다', () => {
    const { expiresAtMs: _drop, ...release } = hold({ held: false });
    expect(parseEventRefundHold(release)).toMatchObject({ held: false, eventId: EVENT, cancellationRequestId: REQUEST });
    expect(invalid(() => parseEventRefundHold(hold({ eventId: EVENT.toUpperCase() })))).toBe(true);
    expect(invalid(() => parseEventRefundHold(hold({ cancellationRequestId: 'req-1' })))).toBe(true);
  });

  test('GAT-110 D3 서비스 setHold는 검사를 지난 입력만 미룸 저장소에 넘기고 그 상태를 돌려준다', async () => {
    const calls: EventRefundHoldInput[] = [];
    const holds: EventRefundHolds = {
      set: async (i) => (calls.push(i), { held: i.held, ...(i.expiresAtMs !== undefined ? { expiresAtMs: i.expiresAtMs } : {}) }),
      releaseExpired: async () => [],
    };
    const service = new EventRefundService({
      store: new MemoryEventRefundStore(),
      targets: { list: async () => [] },
      canceller: { cancel: async () => ({ status: 'REFUNDED' }) },
      holds,
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    expect(await service.setHold(hold())).toEqual({ held: true, expiresAtMs: NOW + 259_200_000 });
    expect(calls).toEqual([hold()]);
    await expect(service.setHold(hold({ expiresAtMs: NOW + SEVEN_DAYS + 1 }))).rejects.toMatchObject({ code: 'INVALID' });
    expect(calls).toHaveLength(1);
  });
});

describe('SetEventRefundHold gRPC 처리기 [BAT-420 몫 D]', () => {
  const TOKEN = 'internal-grpc-token-ops-to-purchase';
  const seen: EventRefundHoldInput[] = [];
  let answer: (i: EventRefundHoldInput) => Promise<{ held: boolean; expiresAtMs?: number }> = async (i) => ({ held: i.held, ...(i.expiresAtMs !== undefined ? { expiresAtMs: i.expiresAtMs } : {}) });
  const useCases = {
    preview: async () => Promise.reject(new Error('이 시험은 부르지 않는다')),
    start: async () => Promise.reject(new Error('이 시험은 부르지 않는다')),
    get: async () => Promise.reject(new Error('이 시험은 부르지 않는다')),
    pause: async () => Promise.reject(new Error('이 시험은 부르지 않는다')),
    resume: async () => Promise.reject(new Error('이 시험은 부르지 않는다')),
    apply: async () => Promise.reject(new Error('이 시험은 부르지 않는다')),
    closeWindow: async () => Promise.reject(new Error('이 시험은 부르지 않는다')),
    setHold: async (i: EventRefundHoldInput) => (seen.push(i), answer(i)),
  } as unknown as ConstructorParameters<typeof EventRefundGrpcController>[0];
  let guarded: { port: number; close(): Promise<void> };
  let open: { port: number; close(): Promise<void> };
  type Client = grpc.Client & { SetEventRefundHold(req: object, md: grpc.Metadata, cb: (e: grpc.ServiceError | null, v: Record<string, unknown>) => void): void };
  const clientOf = (port: number) => new (eventRefundPackage().EventRefundService)(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as unknown as Client;
  const md = (caller?: string, token: string | undefined = TOKEN) => {
    const m = new grpc.Metadata();
    if (token !== undefined) m.set(INTERNAL_GRPC_TOKEN_HEADER, token);
    if (caller !== undefined) m.set(INTERNAL_GRPC_CALLER_HEADER, caller);
    return m;
  };
  const call = (c: Client, req: object, m = new grpc.Metadata()) => new Promise<Record<string, unknown>>((res, rej) => c.SetEventRefundHold(req, m, (e, v) => (e ? rej(e) : res(v))));
  const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

  beforeAll(async () => {
    guarded = await startPurchaseGrpcServer({
      host: '127.0.0.1',
      port: 0,
      services: [{ definition: eventRefundPackage().EventRefundService.service, handlers: new EventRefundGrpcController(useCases, { internalToken: TOKEN, nowMs: () => NOW }).handlers() }],
    });
    open = await startPurchaseGrpcServer({
      host: '127.0.0.1',
      port: 0,
      services: [{ definition: eventRefundPackage().EventRefundService.service, handlers: new EventRefundGrpcController(useCases, { nowMs: () => NOW }).handlers() }],
    });
  });
  afterAll(async () => {
    await guarded?.close();
    await open?.close();
  });
  beforeEach(() => {
    seen.length = 0;
    answer = async (i) => ({ held: i.held, ...(i.expiresAtMs !== undefined ? { expiresAtMs: i.expiresAtMs } : {}) });
  });

  test('GAT-110 D3 SetEventRefundHold는 회차·요청 ID·held·기한(Timestamp)과 서버 시계를 setHold에 넘기고 held·expires_at을 답한다', async () => {
    const c = clientOf(guarded.port);
    try {
      const expiresAtMs = NOW + 259_200_000 + 250;
      const r = await call(c, { event_id: EVENT, cancellation_request_id: REQUEST, held: true, expires_at: ts(expiresAtMs) }, md('ops-svc'));
      expect(seen).toEqual([{ eventId: EVENT, cancellationRequestId: REQUEST, held: true, expiresAtMs, nowMs: NOW }]);
      expect(r).toMatchObject({ held: true, expires_at: { seconds: Math.floor(expiresAtMs / 1000) } });
      const off = await call(c, { event_id: EVENT, cancellation_request_id: REQUEST, held: false }, md('ops-svc'));
      expect(seen[1]).toEqual({ eventId: EVENT, cancellationRequestId: REQUEST, held: false, nowMs: NOW });
      expect(off.held).toBe(false);
    } finally {
      c.close();
    }
  });

  test('GAT-110 D3 [ASVS v5.0.0-8.2.1] 내부 토큰이 있으면 호출자 ops-svc만 받고 다른 호출자·토큰 없음은 PERMISSION_DENIED이며 setHold를 부르지 않는다', async () => {
    const c = clientOf(guarded.port);
    try {
      const req = { event_id: EVENT, cancellation_request_id: REQUEST, held: true, expires_at: ts(NOW + 1_000) };
      for (const m of [md('trust-svc'), md(undefined), md('ops-svc', 'wrong-token'), new grpc.Metadata()]) {
        await expect(call(c, req, m)).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
      }
      expect(seen).toEqual([]);
      // 토큰을 두지 않은 local·ci 조립은 지금처럼 받는다
      const o = clientOf(open.port);
      try {
        expect((await call(o, req)).held).toBe(true);
      } finally {
        o.close();
      }
    } finally {
      c.close();
    }
  });

  test('GAT-110 D3 INVALID는 INVALID_ARGUMENT, ALREADY_EXISTS는 ALREADY_EXISTS, 그 밖은 원문 없는 INTERNAL이다', async () => {
    const c = clientOf(guarded.port);
    try {
      const req = { event_id: EVENT, cancellation_request_id: REQUEST, held: true, expires_at: ts(NOW + 1_000) };
      answer = async () => Promise.reject(new EventRefundHoldError('INVALID', '기한이 틀렸다'));
      await expect(call(c, req, md('ops-svc'))).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
      answer = async () => Promise.reject(new EventRefundHoldError('ALREADY_EXISTS', '다른 요청의 미룸이 있다'));
      await expect(call(c, req, md('ops-svc'))).rejects.toMatchObject({ code: grpc.status.ALREADY_EXISTS });
      answer = async () => Promise.reject(new Error('pg secret-host-name down'));
      const err = (await call(c, req, md('ops-svc')).catch((e: grpc.ServiceError) => e)) as grpc.ServiceError;
      expect(err.code).toBe(grpc.status.INTERNAL);
      expect(String(err.details)).not.toContain('secret-host-name');
    } finally {
      c.close();
    }
  });
});

describe('기한 지난 미룸 풀기 [BAT-420 몫 D]', () => {
  test('R-T38 ⑤ 환급 실행기는 틱 맨 앞에 기한 지난 미룸을 풀고 풀린 줄마다 SEV2 event-refund-hold-expired를 한 번 남긴다(다음 틱은 0)', async () => {
    const order: string[] = [];
    const released = [{ eventId: EVENT, cancellationRequestId: REQUEST }];
    const lines: { level: string; o: object; msg: string }[] = [];
    let first = true;
    const runner = new RefundAfterEntry({
      nowMs: () => NOW,
      writes: { dueRefunds: async () => (order.push('due'), []) } as never,
      payments: { cancel: async () => 'CANCELLED' },
      entries: { lookup: async () => new Map() },
      claims: { claimDue: async () => true, markEntryRecorded: async () => true },
      holds: {
        releaseExpired: async (nowMs, limit) => {
          order.push(`release:${nowMs}:${limit}`);
          const out = first ? released : [];
          first = false;
          return out;
        },
      },
      log: { warn: (o, msg) => void lines.push({ level: 'warn', o, msg }), error: (o, msg) => void lines.push({ level: 'error', o, msg }) },
    });
    await runner.run();
    expect(order).toEqual([`release:${NOW}:100`, 'due']);
    const expired = lines.filter((l) => JSON.stringify(l).includes('event-refund-hold-expired'));
    expect(expired).toHaveLength(1);
    expect(JSON.stringify(expired[0])).toContain(EVENT);
    expect(JSON.stringify(expired[0])).toContain(REQUEST);
    expect(JSON.stringify(expired[0])).toMatch(/SEV2/);
    await runner.run();
    expect(lines.filter((l) => JSON.stringify(l).includes('event-refund-hold-expired'))).toHaveLength(1);
  });
});

describe('남는 차액 CS 건 어댑터 [BAT-420 몫 D]', () => {
  /** sha256(`deduction-gap:${id}`) 앞 16바이트를 8-4-4-4-12로(시험이 직접 계산한다) */
  const gapKey = (id: string) => {
    const h = createHash('sha256').update(`deduction-gap:${id}`).digest('hex').slice(0, 32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };

  test('R-T38 ④ 차액 건은 ops CS 처리함에 REFUND_FAILED·DEDUCTION_GAP·그 취소 ID·정해진 eventKey로 내부 토큰과 5,000ms 안에 보내고 실패는 삼킨다', async () => {
    const sent: ExternalRequest[] = [];
    const notice = new HttpDeductionGapNotice({ request: async (r: ExternalRequest) => (sent.push(r), new Response('{"accepted":true}', { status: 202 })) }, 'it-token');
    const cancellationId = randomUUID();
    await notice.open({ cancellationId, orderId: randomUUID(), deductionAmount: 29_999, requestId: REQUEST, nowMs: NOW });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'POST', path: '/internal/v1/cs-cases', timeoutCapMs: 5_000, headers: expect.objectContaining({ 'x-peaket-internal-token': 'it-token' }) });
    expect(JSON.parse(String(sent[0]!.body))).toEqual({ eventKey: gapKey(cancellationId), kind: 'REFUND_FAILED', sourceId: cancellationId, category: 'DEDUCTION_GAP', createdAt: new Date(NOW).toISOString() });
    // 같은 취소는 같은 eventKey(다시 보내도 ops가 한 건으로 모은다)
    await notice.open({ cancellationId, orderId: randomUUID(), deductionAmount: 29_999, requestId: REQUEST, nowMs: NOW + 1 });
    expect(JSON.parse(String(sent[1]!.body)).eventKey).toBe(gapKey(cancellationId));
    const down = new HttpDeductionGapNotice({ request: async () => Promise.reject(new Error('ops down')) }, 'it-token');
    await expect(down.open({ cancellationId, orderId: randomUUID(), deductionAmount: 1, requestId: REQUEST, nowMs: NOW })).resolves.toBeUndefined();
  });
});
