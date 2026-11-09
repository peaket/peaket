// 쓰임새 둘(AcceptPaymentCommand·BatchGetPaymentStates)과 어댑터 둘(paymentCommandLog·PromPaymentCommandSignals)을 대역으로 본다
// (docs/features/payment.md §2 '승인 명령 접수의 첫 구현'·'서버 쪽 답 고르기', BUILD_ORDER PRF-180). 한 트랜잭션과 유일 제약의 실제 동작은 test-int가 본다.
import { Writable } from 'node:stream';
import { createPlatformLogger, fakeClock, PlatformMetrics, type Registry, systemClock, uuidv7Time } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { paymentCommandLog } from '../src/modules/payment/adapters/payment-command-log.js';
import { PromPaymentCommandSignals } from '../src/modules/payment/adapters/prom-payment-command-signals.js';
import { AcceptPaymentCommand } from '../src/modules/payment/application/accept-payment-command.js';
import { BatchGetPaymentStates } from '../src/modules/payment/application/batch-get-payment-states.js';
import { type ConfirmPaymentInput, PaymentCommandMismatchError, PaymentInputError } from '../src/modules/payment/domain/confirm-command.js';
import {
  ATTEMPT_ID,
  AUTHENTICATED_AT,
  EVENT_ID,
  FakeCommandLog,
  FakeCommandStore,
  FakeSignals,
  FakeStateReader,
  NOW,
  ORDER_ID,
  OTHER_ATTEMPT_ID,
  PAYMENT_ID,
  portoneInput,
  recordOf,
  rejectedBy,
  SECRET_PAYMENT_KEY,
  SECRET_PAYMENT_TOKEN,
  stateOf,
  tossInput,
  TX_ID,
  uuidAt,
} from './confirm-cases.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function acceptFixture() {
  const store = new FakeCommandStore();
  const log = new FakeCommandLog();
  const signals = new FakeSignals();
  const accept = new AcceptPaymentCommand({ store, clock: fakeClock({ now: NOW }), log, signals });
  return { store, log, signals, accept };
}

describe('AcceptPaymentCommand: 처음 받음', () => {
  test('P-T53_저장소를 한 번 부르고 IN_PROGRESS와 새 결제 ID를 답한다, 지표는 accepted [ASVS v5.0.0-2.3.4]', async () => {
    const { store, log, signals, accept } = acceptFixture();
    const answer = await accept.execute(tossInput());
    expect(store.writes).toBe(1);
    expect(store.calls).toHaveLength(1);
    expect(answer).toEqual({ result: 'IN_PROGRESS', paymentId: store.calls[0]!.values.paymentId });
    expect(signals.confirm).toEqual(['accepted']);
    expect(log.mismatches).toEqual([]);
  });

  test('P-T53_세 행(원장·이력 첫 행·승인 명령)을 저장소 호출 하나로 넘긴다(한 트랜잭션은 저장소의 몫이고, 쓰임새가 나눠 쓰지 않는다) [ASVS v5.0.0-2.3.3]', async () => {
    const { store, accept } = acceptFixture();
    await accept.execute(tossInput());
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]!.command).toEqual({
      orderId: ORDER_ID,
      attemptId: ATTEMPT_ID,
      attemptNo: 1,
      eventId: EVENT_ID,
      pg: 'TOSS',
      paymentRef: { kind: 'toss', paymentKey: SECRET_PAYMENT_KEY },
      amount: 55_000,
      authenticatedAtMs: AUTHENTICATED_AT,
    });
  });

  test('P-T53_결제 ID·이력 사건 키는 주입한 시계의 UUIDv7이고 서로 다르다, nowMs는 시계 값이다', async () => {
    const { store, accept } = acceptFixture();
    await accept.execute(tossInput());
    const v = store.calls[0]!.values;
    expect(v.paymentId).toMatch(UUID_V7);
    expect(v.eventKey).toMatch(UUID_V7);
    expect(v.eventKey).not.toBe(v.paymentId);
    expect(uuidv7Time(v.paymentId)).toBe(NOW);
    expect(uuidv7Time(v.eventKey)).toBe(NOW);
    expect(v.nowMs).toBe(NOW);
  });
});

describe('AcceptPaymentCommand: 다시 받음', () => {
  test('P-T53_같은 명령을 다시 받으면 쓰지 않고 같은 답이다, 지표는 replayed [ASVS v5.0.0-2.3.4]', async () => {
    const { store, signals, accept } = acceptFixture();
    const first = await accept.execute(tossInput());
    const second = await accept.execute(tossInput());
    expect(second).toEqual(first);
    expect(store.writes).toBe(1);
    expect(store.records.size).toBe(1);
    expect(signals.confirm).toEqual(['accepted', 'replayed']);
  });

  test('P-T53_겹친 두 명령은 하나만 쓰고 둘 다 같은 답이다 [ASVS v5.0.0-2.3.4]', async () => {
    const { store, signals, accept } = acceptFixture();
    const [a, b] = await Promise.all([accept.execute(tossInput()), accept.execute(tossInput())]);
    expect(a).toEqual(b);
    expect(store.writes).toBe(1);
    expect([...signals.confirm].sort()).toEqual(['accepted', 'replayed']);
  });

  test('P-T53_결제 참조만 다른 다시 보내기는 거절하지 않고 같은 답이다 [ASVS v5.0.0-2.3.4]', async () => {
    const { store, log, accept } = acceptFixture();
    const first = await accept.execute(tossInput());
    expect(await accept.execute(tossInput({ paymentRef: { kind: 'toss', paymentKey: 'another-key' } }))).toEqual(first);
    expect(store.writes).toBe(1);
    expect(log.mismatches).toEqual([]);
  });

  test.each([
    ['APPROVED', { status: 'APPROVED', approvedAtMs: 1_794_200_000_123 }, { result: 'APPROVED', paymentId: PAYMENT_ID, approvedAtMs: 1_794_200_000_123 }],
    ['FAILED', { status: 'FAILED', failureCategory: 'CARD_DECLINED' }, { result: 'DECLINED', paymentId: PAYMENT_ID, failureCategory: 'CARD_DECLINED' }],
    ['AWAITING_DEPOSIT', { status: 'AWAITING_DEPOSIT' }, { result: 'WAITING_FOR_DEPOSIT', paymentId: PAYMENT_ID }],
    ['UNKNOWN', { status: 'UNKNOWN' }, { result: 'IN_PROGRESS', paymentId: PAYMENT_ID }],
  ] as const)('P-T53_끝났거나 진행 중인 결제(%s)를 다시 받으면 지금 상태의 답을 준다', async (_name, over, expected) => {
    const { store, signals, accept } = acceptFixture();
    store.records.set(ORDER_ID, recordOf(over));
    expect(await accept.execute(tossInput())).toEqual(expected);
    expect(store.writes).toBe(0);
    expect(signals.confirm).toEqual(['replayed']);
  });
});

describe('AcceptPaymentCommand: 다른 명령', () => {
  const CASES: readonly (readonly [string, ConfirmPaymentInput])[] = [
    ['attempt_id', tossInput({ attemptId: OTHER_ATTEMPT_ID })],
    ['pg', portoneInput()],
    ['금액', tossInput({ amount: 55_001 })],
  ];

  test.each(CASES)('P-T53_%s가 다르면 PaymentCommandMismatchError이고 원장을 바꾸지 않는다, 지표는 mismatch [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-2.3.4]', async (_name, input) => {
    const { store, signals, accept } = acceptFixture();
    await accept.execute(tossInput());
    const before = store.records.get(ORDER_ID);
    const err = await rejectedBy(accept.execute(input));
    expect(err).toBeInstanceOf(PaymentCommandMismatchError);
    expect((err as PaymentCommandMismatchError).code).toBe('FAILED_PRECONDITION');
    expect(store.writes).toBe(1);
    expect(store.records.get(ORDER_ID)).toBe(before);
    expect(signals.confirm).toEqual(['accepted', 'mismatch']);
  });

  test.each(CASES)('P-T53_%s가 다르면 SEV2 로그에 주문 ID만 넘긴다(결제 키·토큰·금액 없음) [ASVS v5.0.0-16.2.5]', async (_name, input) => {
    const { log, accept } = acceptFixture();
    await accept.execute(tossInput());
    await rejectedBy(accept.execute(input));
    expect(log.mismatches).toEqual([{ orderId: ORDER_ID }]);
    expect(Object.keys(log.mismatches[0] as object)).toEqual(['orderId']);
  });

  test('P-T53_거절 오류의 글에 주문 ID·결제 키·토큰이 없다 [ASVS v5.0.0-16.2.5]', async () => {
    const { accept } = acceptFixture();
    await accept.execute(tossInput());
    const err = (await rejectedBy(accept.execute(portoneInput()))) as PaymentCommandMismatchError;
    expect(err).toBeInstanceOf(PaymentCommandMismatchError);
    const text =[err.message, String(err), JSON.stringify(err)].join('\n');
    for (const secret of [ORDER_ID, SECRET_PAYMENT_KEY, SECRET_PAYMENT_TOKEN, TX_ID]) expect(text).not.toContain(secret);
  });
});

describe('AcceptPaymentCommand: 틀린 입력과 저장소 오류', () => {
  test.each([
    ['UUID 모양', tossInput({ orderId: ORDER_ID.toUpperCase() })],
    ['금액 0', tossInput({ amount: 0 })],
    ['결제사와 맞지 않는 참조', tossInput({ pg: 'PORTONE' })],
    ['인증 시각 없음', tossInput({ authenticatedAtMs: undefined })],
  ])('P-T53_%s이면 PaymentInputError이고 저장소를 부르지 않는다, 지표는 invalid [ASVS v5.0.0-2.2.1]', async (_name, input) => {
    const { store, log, signals, accept } = acceptFixture();
    expect(await rejectedBy(accept.execute(input))).toBeInstanceOf(PaymentInputError);
    expect(store.calls).toEqual([]);
    expect(signals.confirm).toEqual(['invalid']);
    expect(log.mismatches).toEqual([]);
  });

  test('P-T53_리뷰 고침 L7: 저장소 오류는 그대로 던지고 지표 error로 센다(accepted로 세지 않는다, 쓰지 못한 명령을 받았다고 답하지 않는다) [ASVS v5.0.0-2.3.3]', async () => {
    const { store, log, signals, accept } = acceptFixture();
    const failure = new Error('연결 끊김');
    store.failure = failure;
    expect(await rejectedBy(accept.execute(tossInput()))).toBe(failure);
    expect(signals.confirm).toEqual(['error']);
    expect(log.mismatches).toEqual([]);
  });

  test('P-T53_저장소가 실패한 뒤 같은 명령을 다시 보내면 처음처럼 받는다 [ASVS v5.0.0-2.3.3]', async () => {
    const { store, signals, accept } = acceptFixture();
    store.failure = new Error('연결 끊김');
    await rejectedBy(accept.execute(tossInput()));
    store.failure = undefined;
    expect((await accept.execute(tossInput())).result).toBe('IN_PROGRESS');
    expect(store.writes).toBe(1);
    expect(signals.confirm).toEqual(['error', 'accepted']);
  });

  test('P-T53_리뷰 고침 L8: 인증 시각이 시계 + 5분보다 뒤면 PaymentInputError이고 저장소를 부르지 않는다, 지표는 invalid [ASVS v5.0.0-2.2.1]', async () => {
    const { store, signals, accept } = acceptFixture();
    const err = await rejectedBy(accept.execute(tossInput({ authenticatedAtMs: NOW + 300_001 })));
    expect(err).toBeInstanceOf(PaymentInputError);
    expect((err as PaymentInputError).field).toBe('authenticated_at');
    expect(store.calls).toEqual([]);
    expect(signals.confirm).toEqual(['invalid']);
  });

  test('P-T53_리뷰 고침 M4: 남은 시간을 저장소에 그대로 넘긴다(문장 시간 한도의 재료)', async () => {
    const { store, accept } = acceptFixture();
    await accept.execute(tossInput(), { remainingMs: 150 });
    expect(store.calls[0]!.budget).toEqual({ remainingMs: 150 });
  });
});

describe('BatchGetPaymentStates', () => {
  function batchFixture() {
    const reader = new FakeStateReader();
    const signals = new FakeSignals();
    return { reader, signals, batch: new BatchGetPaymentStates({ reader, signals }) };
  }

  test('P-T54_읽은 결과를 그대로 돌려준다, 지표는 ok', async () => {
    const { reader, signals, batch } = batchFixture();
    const states = [stateOf({ status: 'APPROVED', approvedAtMs: 1_794_200_000_123, lastEvent: { eventKey: uuidAt(50), eventSeq: 3 } })];
    reader.states = states;
    expect(await batch.execute([ORDER_ID])).toEqual(states);
    expect(reader.calls).toEqual([[ORDER_ID]]);
    expect(signals.batch).toEqual(['ok']);
  });

  test('P-T54_없는 주문은 답에 만들어 넣지 않는다', async () => {
    const { reader, batch } = batchFixture();
    reader.states = [stateOf()];
    expect(await batch.execute([ORDER_ID, uuidAt(1)])).toEqual([stateOf()]);
  });

  test('P-T54_같은 주문을 합쳐서 읽는다', async () => {
    const { reader, batch } = batchFixture();
    await batch.execute([ORDER_ID, ORDER_ID]);
    expect(reader.calls).toEqual([[ORDER_ID]]);
  });

  test.each([
    ['0건', []],
    ['101건', Array.from({ length: 101 }, (_, i) => uuidAt(i + 1))],
    ['대문자', [ORDER_ID.toUpperCase()]],
  ])('P-T54_%s면 PaymentInputError이고 읽지 않는다, 지표는 invalid [ASVS v5.0.0-2.2.1]', async (_name, input) => {
    const { reader, signals, batch } = batchFixture();
    expect(await rejectedBy(batch.execute(input))).toBeInstanceOf(PaymentInputError);
    expect(reader.calls).toEqual([]);
    expect(signals.batch).toEqual(['invalid']);
  });

  test('P-T54_읽기 오류는 그대로 던진다, 지표는 error', async () => {
    const { reader, signals, batch } = batchFixture();
    const failure = new Error('문장 시간 한도');
    reader.failure = failure;
    expect(await rejectedBy(batch.execute([ORDER_ID]))).toBe(failure);
    expect(signals.batch).toEqual(['error']);
  });

  test('P-T54_리뷰 고침 M4: 남은 시간을 읽기에 그대로 넘긴다', async () => {
    const { reader, batch } = batchFixture();
    await batch.execute([ORDER_ID], { remainingMs: 320 });
    expect(reader.budgets).toEqual([{ remainingMs: 320 }]);
  });
});

describe('paymentCommandLog', () => {
  function realLogger() {
    const lines: Record<string, unknown>[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
        done();
      },
    });
    return { lines, logger: createPlatformLogger({ service: 'payment-svc', env: 'test', version: 't', pod: 'p', clock: systemClock, level: 'info', destination }) };
  }

  test('P-T53_거절은 error 한 줄이고 kind는 payment-confirm-mismatch, 주문 ID를 싣는다 [ASVS v5.0.0-16.2.5]', () => {
    const { lines, logger } = realLogger();
    paymentCommandLog(logger).mismatch({ orderId: ORDER_ID });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', kind: 'payment-confirm-mismatch', orderId: ORDER_ID });
  });

  test('P-T53_거절 줄에 결제 값 칸이 없다 [ASVS v5.0.0-16.2.5]', () => {
    const { lines, logger } = realLogger();
    paymentCommandLog(logger).mismatch({ orderId: ORDER_ID });
    for (const key of ['paymentKey', 'paymentToken', 'paymentRef', 'txId', 'amount', 'pg']) expect(lines[0]).not.toHaveProperty(key);
  });

  test('P-T53_쓰임새에 이어 붙여도 어떤 로그 줄에도 결제 키·토큰이 없다 [ASVS v5.0.0-16.2.5]', async () => {
    const { lines, logger } = realLogger();
    const store = new FakeCommandStore();
    const accept = new AcceptPaymentCommand({ store, clock: fakeClock({ now: NOW }), log: paymentCommandLog(logger), signals: new FakeSignals() });
    await accept.execute(tossInput());
    await rejectedBy(accept.execute(portoneInput()));
    await rejectedBy(accept.execute(tossInput({ paymentRef: { kind: 'toss', paymentKey: `${SECRET_PAYMENT_KEY} ` } })));
    const text = JSON.stringify(lines);
    expect(lines.filter((l) => l.kind === 'payment-confirm-mismatch')).toHaveLength(1);
    for (const secret of [SECRET_PAYMENT_KEY, SECRET_PAYMENT_TOKEN, TX_ID]) expect(text).not.toContain(secret);
  });
});

describe('PromPaymentCommandSignals', () => {
  const lines = async (registry: Registry, name: string): Promise<string[]> => (await registry.metrics()).split('\n').filter((l) => l.startsWith(`${name}{`));

  test('P-T53_리뷰 고침 L7: payment_confirm_commands_total은 outcome 다섯을 따로 센다(저장 실패 error 포함)', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const prom = new PromPaymentCommandSignals();
    prom.register(metrics.registry);
    prom.confirmCommand('accepted');
    prom.confirmCommand('accepted');
    prom.confirmCommand('replayed');
    prom.confirmCommand('mismatch');
    prom.confirmCommand('invalid');
    prom.confirmCommand('error');
    const got = await lines(metrics.registry, 'payment_confirm_commands_total');
    expect(got).toContain('payment_confirm_commands_total{outcome="accepted"} 2');
    expect(got).toContain('payment_confirm_commands_total{outcome="replayed"} 1');
    expect(got).toContain('payment_confirm_commands_total{outcome="mismatch"} 1');
    expect(got).toContain('payment_confirm_commands_total{outcome="invalid"} 1');
    expect(got).toContain('payment_confirm_commands_total{outcome="error"} 1');
    expect(await metrics.registry.metrics()).toContain('# TYPE payment_confirm_commands_total counter');
  });

  test('P-T53_리뷰 고침 L7: 일어나기 전에도 error 이름표를 0으로 보인다(경보식이 값을 보게)', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    new PromPaymentCommandSignals().register(metrics.registry);
    expect(await lines(metrics.registry, 'payment_confirm_commands_total')).toContain('payment_confirm_commands_total{outcome="error"} 0');
  });

  test('PRF180_payment_batch_get_requests_total은 outcome 셋을 따로 센다', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const prom = new PromPaymentCommandSignals();
    prom.register(metrics.registry);
    prom.batchGet('ok');
    prom.batchGet('invalid');
    prom.batchGet('error');
    prom.batchGet('error');
    const got = await lines(metrics.registry, 'payment_batch_get_requests_total');
    expect(got).toContain('payment_batch_get_requests_total{outcome="ok"} 1');
    expect(got).toContain('payment_batch_get_requests_total{outcome="invalid"} 1');
    expect(got).toContain('payment_batch_get_requests_total{outcome="error"} 2');
    expect(await metrics.registry.metrics()).toContain('# TYPE payment_batch_get_requests_total counter');
  });

  test('PRF180_레지스트리에 붙이기 전에 불러도 던지지 않는다', () => {
    const prom = new PromPaymentCommandSignals();
    expect(() => {
      prom.confirmCommand('accepted');
      prom.batchGet('ok');
    }).not.toThrow();
  });
});
