// PG 시뮬레이터 시험(docs/features/payment.md §2.1 'PG사별 기술 명세 대조'·'기본 승인 지연', ADR-0029 결정 6, openspec 변경 add-invariant-checker-and-pg-simulator).
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIRM_LATENCY, buildSimulatorApp, latencySampler, loadSimulatorConfig, seededRandom, type SimulatorApp } from '../src/index.js';

const KEY = 'sim_sk_test_0123456789abcdef';
const AUTH = { authorization: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}` };
const KST = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/;
const ORDER = '0195f3a0-0000-7000-8000-000000000001';
const ORDER2 = '0195f3a0-0000-7000-8000-000000000002';

function clock(start = Date.parse('2026-11-02T01:00:00.000Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** 시험이 풀어 줄 때까지 기다리는 sleep(처리 중 경합을 만들려고) */
function gatedSleep() {
  const waiting: Array<() => void> = [];
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms);
      return new Promise<void>((r) => waiting.push(r));
    },
    releaseAll: () => waiting.splice(0).forEach((r) => r()),
  };
}

const apps: SimulatorApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function make(o: { sleep?: (ms: number) => Promise<void>; clock?: ReturnType<typeof clock> } = {}) {
  const c = o.clock ?? clock();
  const app = buildSimulatorApp({ secretKey: KEY, clock: c, sleep: o.sleep ?? (async () => {}), seed: 7, confirmLatency: { kind: 'none' } });
  apps.push(app);
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method, url, headers: { ...AUTH, ...headers }, ...(body === undefined ? {} : { payload: body as object }) });
    return { status: r.statusCode, body: r.body ? safeJson(r.body) : undefined, raw: r.body, headers: r.headers };
  };
  const authenticate = async (orderId = ORDER, amount = 10_000) => {
    const r = await call('POST', '/sim/authenticate', { orderId, amount, orderName: '공연 티켓 2매' });
    expect(r.status).toBe(200);
    return (r.body as { paymentKey: string }).paymentKey;
  };
  const confirm = (paymentKey: string, orderId = ORDER, amount = 10_000, idem = `confirm-${orderId}`) =>
    call('POST', '/v1/payments/confirm', { paymentKey, orderId, amount }, { 'idempotency-key': idem });
  const cancel = (paymentKey: string, body: { cancelReason?: string; cancelAmount?: number }, idem: string) =>
    call('POST', `/v1/payments/${paymentKey}/cancel`, body, { 'idempotency-key': idem });
  const fault = (f: Record<string, unknown>) => call('POST', '/sim/faults', f);
  const ledger = async () => {
    const r = await call('GET', '/sim/ledger');
    return r.raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  return { app, clock: c, call, authenticate, confirm, cancel, fault, ledger };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

describe('설정([ASVS v5.0.0-13.3.1]·[ASVS v5.0.0-13.4.2]·[ASVS v5.0.0-13.4.5])', () => {
  it('운영이거나 환경 값이 없으면 시작하지 않는다', () => {
    expect(() => loadSimulatorConfig({ PG_SIMULATOR_SECRET_KEY: KEY })).toThrow(/PEAKET_ENV/);
    expect(() => loadSimulatorConfig({ PEAKET_ENV: 'prod', PG_SIMULATOR_SECRET_KEY: KEY })).toThrow(/PEAKET_ENV/);
  });

  it('시험 키(sim_sk_, 16자 이상 꼬리)만 받는다', () => {
    expect(() => loadSimulatorConfig({ PEAKET_ENV: 'local', PG_SIMULATOR_SECRET_KEY: 'test_sk_0123456789abcdef' })).toThrow(/sim_sk_/);
    expect(() => loadSimulatorConfig({ PEAKET_ENV: 'local', PG_SIMULATOR_SECRET_KEY: 'sim_sk_short' })).toThrow(/sim_sk_/);
    expect(() => loadSimulatorConfig({ PEAKET_ENV: 'local' })).toThrow(/PG_SIMULATOR_SECRET_KEY/);
  });

  it('기본은 루프백 8790번이고 시드·지연을 고를 수 있다', () => {
    expect(loadSimulatorConfig({ PEAKET_ENV: 'ci', PG_SIMULATOR_SECRET_KEY: KEY })).toEqual({
      secretKey: KEY,
      host: '127.0.0.1',
      port: 8790,
      seed: undefined,
      confirmLatency: DEFAULT_CONFIRM_LATENCY,
    });
    const c = loadSimulatorConfig({ PEAKET_ENV: 'demo', PG_SIMULATOR_SECRET_KEY: KEY, PG_SIMULATOR_HOST: '0.0.0.0', PG_SIMULATOR_PORT: '9000', PG_SIMULATOR_SEED: '42', PG_SIMULATOR_LATENCY: 'none' });
    expect(c).toMatchObject({ host: '0.0.0.0', port: 9000, seed: 42, confirmLatency: { kind: 'none' } });
    expect(() => loadSimulatorConfig({ PEAKET_ENV: 'local', PG_SIMULATOR_SECRET_KEY: KEY, PG_SIMULATOR_PORT: 'x' })).toThrow(/PG_SIMULATOR_PORT/);
  });
});

describe('기본 인증([ASVS v5.0.0-8.2.1])', () => {
  it('키가 다르거나 없으면 401 UNAUTHORIZED_KEY이고 상태가 바뀌지 않는다', async () => {
    const s = make();
    const key = await s.authenticate();
    const bad = await s.app.inject({
      method: 'POST',
      url: '/v1/payments/confirm',
      headers: { authorization: `Basic ${Buffer.from('sim_sk_other_0123456789abcdef:').toString('base64')}` },
      payload: { paymentKey: key, orderId: ORDER, amount: 10_000 },
    });
    expect(bad.statusCode).toBe(401);
    expect(JSON.parse(bad.body)).toMatchObject({ code: 'UNAUTHORIZED_KEY' });
    const none = await s.app.inject({ method: 'GET', url: '/sim/ledger' });
    expect(none.statusCode).toBe(401);
    expect(await s.ledger()).toEqual([]);
  });
});

describe('승인 규칙(payment §2.1)', () => {
  it('정상 승인은 DONE이고 시각은 KST 오프셋이다', async () => {
    const s = make();
    const key = await s.authenticate();
    const r = await s.confirm(key);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ paymentKey: key, orderId: ORDER, status: 'DONE', totalAmount: 10_000, balanceAmount: 10_000, method: '카드' });
    const b = r.body as { approvedAt: string; requestedAt: string; card: Record<string, unknown> };
    expect(b.approvedAt).toMatch(KST);
    expect(b.requestedAt).toMatch(KST);
    expect(b.approvedAt).toBe('2026-11-02T10:00:00.000+09:00');
    expect(b.card).toMatchObject({ issuerCode: expect.any(String), cardType: expect.any(String), number: expect.stringMatching(/\*/) });
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('결제창 인증 뒤 10분이 지나면 만료되고 다시 승인할 수 없다', async () => {
    const s = make();
    const key = await s.authenticate();
    s.clock.advance(10 * 60_000 + 1_000);
    const r = await s.confirm(key);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'NOT_FOUND_PAYMENT_SESSION' });
    expect((await s.confirm(key, ORDER, 10_000, 'confirm-again')).body).toMatchObject({ code: 'NOT_FOUND_PAYMENT_SESSION' });
    expect((await s.call('GET', `/v1/payments/${key}`)).body).toMatchObject({ status: 'EXPIRED' });
    expect(await s.ledger()).toEqual([]);
  });

  it('10분 안이면 승인된다', async () => {
    const s = make();
    const key = await s.authenticate();
    s.clock.advance(10 * 60_000 - 1_000);
    expect((await s.confirm(key)).status).toBe(200);
  });

  it('승인된 주문 ID는 다시 쓸 수 없다(DUPLICATED_ORDER_ID)', async () => {
    const s = make();
    const a = await s.authenticate();
    const b = await s.authenticate();
    expect((await s.confirm(a)).status).toBe(200);
    const r = await s.confirm(b, ORDER, 10_000, 'confirm-other-key');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'DUPLICATED_ORDER_ID' });
    const again = await s.call('POST', '/sim/authenticate', { orderId: ORDER, amount: 10_000 });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ code: 'DUPLICATED_ORDER_ID' });
    expect((await s.ledger()).length).toBe(1);
  });

  it('같은 멱등키는 같은 응답을 다시 주고, 다른 본문이면 422다', async () => {
    const s = make();
    const key = await s.authenticate();
    const r1 = await s.confirm(key);
    const r2 = await s.confirm(key);
    expect(r2.status).toBe(200);
    expect(r2.raw).toBe(r1.raw);
    expect((await s.ledger()).length).toBe(1);
    const r3 = await s.confirm(key, ORDER, 9_000);
    expect(r3.status).toBe(422);
    expect(r3.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('멱등키는 15일 보관하고, 지나면 다시 처리해 ALREADY_PROCESSED_PAYMENT다', async () => {
    const s = make();
    const key = await s.authenticate();
    await s.confirm(key);
    s.clock.advance(15 * 24 * 3_600_000 + 1);
    const r = await s.confirm(key);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'ALREADY_PROCESSED_PAYMENT' });
  });

  it('처리 중인 같은 멱등키는 409, 같은 결제의 다른 키는 400 ALREADY_PROCESSING_REQUEST다', async () => {
    const g = gatedSleep();
    const s = make({ sleep: g.sleep });
    const key = await s.authenticate();
    await s.call('PUT', '/sim/latency', { kind: 'fixed', ms: 250 });
    const first = s.confirm(key);
    await new Promise((r) => setTimeout(r, 20));
    const same = await s.confirm(key);
    expect(same.status).toBe(409);
    expect(same.body).toMatchObject({ code: 'IDEMPOTENT_REQUEST_PROCESSING' });
    const other = await s.confirm(key, ORDER, 10_000, 'confirm-different');
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ code: 'ALREADY_PROCESSING_REQUEST' });
    expect(g.calls).toEqual([250]);
    g.releaseAll();
    expect((await first).status).toBe(200);
    expect((await s.ledger()).length).toBe(1);
  });

  it('같은 주문의 두 결제를 동시에 승인해도 승인은 하나이고 다른 하나는 DUPLICATED_ORDER_ID다(새 맥락 리뷰 1)', async () => {
    const s = make({ sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    const a = await s.authenticate();
    const b = await s.authenticate();
    await s.call('PUT', '/sim/latency', { kind: 'fixed', ms: 30 });
    const rs = await Promise.all([s.confirm(a, ORDER, 10_000, 'confirm-a'), s.confirm(b, ORDER, 10_000, 'confirm-b')]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(rs.find((r) => r.status === 400)!.body).toMatchObject({ code: 'DUPLICATED_ORDER_ID' });
    expect((await s.ledger()).length).toBe(1);
  });

  it('이미 승인된 결제를 다른 키로 승인하면 400 ALREADY_PROCESSED_PAYMENT다', async () => {
    const s = make();
    const key = await s.authenticate();
    await s.confirm(key);
    const r = await s.confirm(key, ORDER, 10_000, 'confirm-different');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'ALREADY_PROCESSED_PAYMENT' });
  });

  it('금액이나 주문 ID가 결제창과 다르면 400 INVALID_REQUEST이고 결제는 그대로다', async () => {
    const s = make();
    const key = await s.authenticate();
    expect((await s.confirm(key, ORDER, 9_000, 'k1')).body).toMatchObject({ code: 'INVALID_REQUEST' });
    expect((await s.confirm(key, ORDER2, 10_000, 'k2')).body).toMatchObject({ code: 'INVALID_REQUEST' });
    expect((await s.call('GET', `/v1/payments/${key}`)).body).toMatchObject({ status: 'READY' });
    expect((await s.confirm(key)).status).toBe(200);
  });

  it('없는 결제는 404 NOT_FOUND_PAYMENT, 틀린 본문은 400 INVALID_REQUEST다', async () => {
    const s = make();
    expect((await s.confirm('tsim_nope')).status).toBe(404);
    const r = await s.call('POST', '/v1/payments/confirm', { paymentKey: 'x', orderId: ORDER, amount: -1 });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('주문 ID로 조회하면 승인된 결제를 준다', async () => {
    const s = make();
    await s.authenticate();
    const key = await s.authenticate();
    await s.confirm(key);
    const r = await s.call('GET', `/v1/payments/orders/${ORDER}`);
    expect(r.body).toMatchObject({ paymentKey: key, status: 'DONE' });
    expect((await s.call('GET', `/v1/payments/orders/${ORDER2}`)).status).toBe(404);
  });
});

describe('취소(payment §2.1 결제 취소 API)', () => {
  it('남은 금액 안에서 부분 취소하고, 다 취소하면 CANCELED다', async () => {
    const s = make();
    const key = await s.authenticate();
    await s.confirm(key);
    const p = await s.cancel(key, { cancelReason: '고객 요청', cancelAmount: 3_000 }, 'cancel-c1');
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ status: 'PARTIAL_CANCELED', balanceAmount: 7_000 });
    expect((await s.cancel(key, { cancelReason: '고객 요청', cancelAmount: 3_000 }, 'cancel-c1')).raw).toBe(p.raw);
    expect((await s.cancel(key, { cancelReason: '고객 요청', cancelAmount: 8_000 }, 'cancel-c2')).body).toMatchObject({ code: 'NOT_CANCELABLE_AMOUNT' });
    const all = await s.cancel(key, { cancelReason: '회차 취소' }, 'cancel-c3');
    expect(all.body).toMatchObject({ status: 'CANCELED', balanceAmount: 0 });
    const b = all.body as { cancels: Array<{ cancelAmount: number; canceledAt: string }> };
    expect(b.cancels.map((c) => c.cancelAmount)).toEqual([3_000, 7_000]);
    expect(b.cancels[1]!.canceledAt).toMatch(KST);
    expect((await s.cancel(key, { cancelReason: '다시' }, 'cancel-c4')).body).toMatchObject({ code: 'ALREADY_CANCELED_PAYMENT' });
  });

  it('금액을 생략한 전액 취소는 기다린 뒤의 남은 금액을 취소한다(새 맥락 리뷰 4)', async () => {
    const s = make({ sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    const key = await s.authenticate();
    await s.confirm(key);
    await s.fault({ op: 'cancel', kind: 'delay', ms: 40, times: 1 });
    const full = s.cancel(key, { cancelReason: '회차 취소' }, 'cancel-full');
    await new Promise((r) => setTimeout(r, 10));
    expect((await s.cancel(key, { cancelReason: '고객 요청', cancelAmount: 3_000 }, 'cancel-part')).body).toMatchObject({ status: 'PARTIAL_CANCELED', balanceAmount: 7_000 });
    const r = await full;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'CANCELED', balanceAmount: 0 });
    expect((r.body as { cancels: Array<{ cancelAmount: number }> }).cancels.map((c) => c.cancelAmount)).toEqual([3_000, 7_000]);
  });

  it('승인되지 않은 결제는 403 NOT_CANCELABLE_PAYMENT, 사유가 없으면 400이다', async () => {
    const s = make();
    const key = await s.authenticate();
    const r = await s.cancel(key, { cancelReason: '고객 요청' }, 'cancel-x');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'NOT_CANCELABLE_PAYMENT' });
    await s.confirm(key);
    expect((await s.cancel(key, {}, 'cancel-y')).status).toBe(400);
  });
});

describe('장애 넣기(ADR-0029 결정 6)', () => {
  it('거절은 결제사 코드로 답하고 결제는 ABORTED, 같은 키는 같은 거절이다', async () => {
    const s = make();
    const key = await s.authenticate();
    expect((await s.fault({ op: 'confirm', kind: 'decline', code: 'REJECT_CARD_PAYMENT' })).status).toBe(204);
    const r = await s.confirm(key);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'REJECT_CARD_PAYMENT' });
    expect((await s.confirm(key)).raw).toBe(r.raw);
    expect((await s.call('GET', `/v1/payments/${key}`)).body).toMatchObject({ status: 'ABORTED' });
    expect(await s.ledger()).toEqual([]);
  });

  it('한도 초과(429)와 처리 중(409)은 남기지 않아 같은 키로 다시 하면 처리된다', async () => {
    const s = make();
    const key = await s.authenticate();
    await s.fault({ op: 'confirm', kind: 'throttle', times: 1 });
    await s.fault({ op: 'confirm', kind: 'in-progress', times: 1 });
    const t = await s.confirm(key);
    expect(t.status).toBe(429);
    expect(t.body).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    const ip = await s.confirm(key);
    expect(ip.status).toBe(409);
    expect(ip.body).toMatchObject({ code: 'IDEMPOTENT_REQUEST_PROCESSING' });
    expect((await s.confirm(key)).status).toBe(200);
  });

  it('반영하지 않은 결제사 오류는 500이고 결제는 READY로 남는다', async () => {
    const s = make();
    const key = await s.authenticate();
    await s.fault({ op: 'confirm', kind: 'pg-error', applied: false, times: 1 });
    const r = await s.confirm(key);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: 'FAILED_INTERNAL_SYSTEM_PROCESSING' });
    expect((await s.call('GET', `/v1/payments/${key}`)).body).toMatchObject({ status: 'READY' });
    expect((await s.confirm(key)).status).toBe(200);
  });

  it('반영한 결제사 오류는 500이지만 승인됐고, 같은 키로 다시 하면 승인 응답이다', async () => {
    const s = make();
    const key = await s.authenticate();
    await s.fault({ op: 'confirm', kind: 'pg-error', applied: true, times: 1 });
    expect((await s.confirm(key)).status).toBe(500);
    expect((await s.ledger()).length).toBe(1);
    expect((await s.confirm(key)).body).toMatchObject({ status: 'DONE' });
  });

  it('장애는 주문 ID와 횟수로 고른다', async () => {
    const s = make();
    const a = await s.authenticate(ORDER);
    const b = await s.authenticate(ORDER2);
    await s.fault({ op: 'confirm', kind: 'decline', code: 'EXCEED_MAX_DAILY_PAYMENT_COUNT', orderId: ORDER2, times: 1 });
    expect((await s.confirm(a)).status).toBe(200);
    expect((await s.confirm(b, ORDER2)).body).toMatchObject({ code: 'EXCEED_MAX_DAILY_PAYMENT_COUNT' });
    const c = await s.authenticate('0195f3a0-0000-7000-8000-000000000003');
    expect((await s.confirm(c, '0195f3a0-0000-7000-8000-000000000003')).status).toBe(200);
  });

  it('지연 장애는 그 호출의 기다림에 더한다', async () => {
    const calls: number[] = [];
    const s = make({ sleep: async (ms) => void calls.push(ms) });
    const key = await s.authenticate();
    await s.fault({ op: 'confirm', kind: 'delay', ms: 1_200, times: 1 });
    await s.confirm(key);
    expect(calls).toEqual([1_200]);
  });

  it('틀린 장애 설정은 400이다', async () => {
    const s = make();
    expect((await s.fault({ op: 'confirm', kind: 'decline' })).status).toBe(400);
    expect((await s.fault({ op: 'refund', kind: 'throttle' })).status).toBe(400);
    expect((await s.fault({ op: 'confirm', kind: 'drop' })).status).toBe(400);
  });

  it('응답 유실은 연결을 끊고, 반영했으면 원장에 승인이 남는다', async () => {
    const s = make();
    const key = await s.authenticate();
    await s.fault({ op: 'confirm', kind: 'drop', applied: true, times: 1 });
    const url = await s.app.listen({ host: '127.0.0.1', port: 0 });
    await expect(
      fetch(`${url}/v1/payments/confirm`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json', 'idempotency-key': `confirm-${ORDER}` },
        body: JSON.stringify({ paymentKey: key, orderId: ORDER, amount: 10_000 }),
      }),
    ).rejects.toThrow();
    expect((await s.ledger()).length).toBe(1);
    expect((await s.confirm(key)).body).toMatchObject({ status: 'DONE' });
  });
});

describe('원장·웹훅·초기화', () => {
  it('원장을 불변식 검사기 기록 형식(pg_charge)으로 꺼낸다', async () => {
    const s = make();
    for (const o of [ORDER, ORDER2]) await s.confirm(await s.authenticate(o), o);
    const k3 = await s.authenticate('0195f3a0-0000-7000-8000-000000000003', 5_000);
    await s.confirm(k3, '0195f3a0-0000-7000-8000-000000000003', 5_000);
    await s.cancel(k3, { cancelReason: '부분', cancelAmount: 2_000 }, 'cancel-p');
    const r = await s.call('GET', '/sim/ledger');
    expect(r.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    const rows = await s.ledger();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({
      kind: 'pg_charge',
      pg: 'SIMULATOR',
      payment_ref: k3,
      order_ref: '0195f3a0-0000-7000-8000-000000000003',
      amount: 5_000,
      status: 'PARTIAL_CANCELED',
      approved_at: '2026-11-02T10:00:00.000+09:00',
      canceled_amount: 2_000,
    });
  });

  it('상태가 바뀔 때마다 웹훅 사건을 남긴다(서명 없음, 전송 ID)', async () => {
    const s = make();
    const key = await s.authenticate();
    await s.confirm(key);
    await s.cancel(key, { cancelReason: '고객 요청' }, 'cancel-w');
    const r = await s.call('GET', `/sim/webhooks?paymentKey=${key}`);
    const events = r.body as Array<{ headers: Record<string, string>; body: { eventType: string; createdAt: string; data: { status: string; paymentKey: string } } }>;
    expect(events.map((e) => e.body.data.status)).toEqual(['DONE', 'CANCELED']);
    expect(events[0]!.body.eventType).toBe('PAYMENT_STATUS_CHANGED');
    expect(events[0]!.body.createdAt).toMatch(KST);
    expect(events[0]!.headers['tosspayments-webhook-transmission-id']).toMatch(/^wh_/);
    expect(events[0]!.headers['tosspayments-webhook-transmission-id']).not.toBe(events[1]!.headers['tosspayments-webhook-transmission-id']);
  });

  it('초기화하면 결제·장애·웹훅이 비고 지연은 처음 값이다', async () => {
    const s = make();
    await s.confirm(await s.authenticate());
    await s.fault({ op: 'confirm', kind: 'throttle' });
    expect((await s.call('POST', '/sim/reset')).status).toBe(204);
    expect(await s.ledger()).toEqual([]);
    expect((await s.confirm(await s.authenticate())).status).toBe(200);
  });
});

describe('기본 승인 지연(payment §2.1, 중앙값 300ms·p99 1.5초 [가정])', () => {
  it('고정 시드 1만 회의 중앙값과 p99가 정한 값 근처다', () => {
    const next = latencySampler(DEFAULT_CONFIRM_LATENCY, seededRandom(20261102));
    const xs = Array.from({ length: 10_000 }, () => next()).sort((a, b) => a - b);
    const median = xs[5_000]!;
    const p99 = xs[9_900]!;
    expect(median).toBeGreaterThan(270);
    expect(median).toBeLessThan(330);
    expect(p99).toBeGreaterThan(1_275);
    expect(p99).toBeLessThan(1_725);
    expect(xs.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
  });

  it('시험이 지연을 넣지 않으면 승인마다 기본 분포에서 뽑아 기다린다', async () => {
    const calls: number[] = [];
    const app = buildSimulatorApp({ secretKey: KEY, clock: clock(), sleep: async (ms) => void calls.push(ms), seed: 1 });
    apps.push(app);
    for (const o of [ORDER, ORDER2]) {
      const a = await app.inject({ method: 'POST', url: '/sim/authenticate', headers: AUTH, payload: { orderId: o, amount: 1_000 } });
      const key = (JSON.parse(a.body) as { paymentKey: string }).paymentKey;
      await app.inject({ method: 'POST', url: '/v1/payments/confirm', headers: AUTH, payload: { paymentKey: key, orderId: o, amount: 1_000 } });
    }
    expect(calls).toHaveLength(2);
    expect(calls.every((ms) => ms > 0)).toBe(true);
    expect(calls[0]).not.toBe(calls[1]);
  });

  it('고정·없음 지연과 틀린 지연 설정', () => {
    expect(latencySampler({ kind: 'fixed', ms: 40 }, Math.random)()).toBe(40);
    expect(latencySampler({ kind: 'none' }, Math.random)()).toBe(0);
    expect(() => latencySampler({ kind: 'lognormal', medianMs: 300, p99Ms: 200 }, Math.random)).toThrow(/p99/);
  });
});
