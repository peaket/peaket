// Saga 1단계의 어댑터(BUILD_ORDER PRF-165): 좌석 묶기·실패 해제의 inventory 다리(InventoryOrderSeatPins), 회차 설정(SeatMapSagaConfigs),
// Saga 로그(LoggerSagaLog). docs/features/payment.md §2 'Saga 1단계의 첫 구현'·'좌석 묶기 입력의 구매 세션 ID', docs/features/seat-hold.md §6.
// 좌석 Redis의 Lua(실패 표시·FAILED_HOLD)는 test-int(다른 담당)가 본다. 여기서는 inventory 쪽을 모양만 맞춘 가짜로 둔다.
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  InventoryOrderSeatPins,
  LoggerSagaLog,
  type OrderPinInput,
  OrderSeatStoreUnavailable,
  type PinResultShape,
  type SeatPinSource,
  type SeatRefShape,
  SeatMapSagaConfigs,
} from '../src/modules/booking/index.js';
import { PAYMENT_KEY } from './accept-cases.js';
import { ACCOUNT, DAY, EVENT, HOLD_ID, NOW } from './order-cases.js';

const SAGA_PSID = 'jti_Saga-0001';
const SEAT_1 = '0190f3a1-7c2e-7a00-8000-00000000a001';
const SEAT_2 = '0190f3a1-7c2e-7a00-8000-00000000a002';
const REFS: Record<string, SeatRefShape> = {
  [SEAT_1]: { seatId: SEAT_1, index: 10, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 10, tierId: 'R' },
  [SEAT_2]: { seatId: SEAT_2, index: 3, sectionId: 'SEC-B', sectionIndex: 1, seatOffset: 3, tierId: 'S' },
};

function pinInput(over: Partial<OrderPinInput> = {}): OrderPinInput {
  return { eventId: EVENT, accountId: ACCOUNT, holdId: HOLD_ID, purchaseSessionId: SAGA_PSID, seatIds: [SEAT_2, SEAT_1], limit: 4, orderGen: 3, keepUntilMs: NOW + 3 * DAY, ...over };
}

/** inventory SeatPins·SeatMap.resolve 모양의 가짜 */
function source(o: { pin?: PinResultShape | Error; release?: { kind: 'OK'; released: number } | { kind: 'NOT_READY' } | Error; missing?: string } = {}) {
  const pins: Parameters<SeatPinSource['pins']['pin']>[] = [];
  const releases: Parameters<SeatPinSource['pins']['releaseFailed']>[] = [];
  const resolves: [string, readonly string[]][] = [];
  const src: SeatPinSource = {
    pins: {
      pin: async (...args) => {
        pins.push(args);
        if (o.pin instanceof Error) throw o.pin;
        return o.pin ?? { kind: 'OK', gen: 3, regrabbed: 0 };
      },
      releaseFailed: async (...args) => {
        releases.push(args);
        if (o.release instanceof Error) throw o.release;
        return o.release ?? { kind: 'OK', released: 2 };
      },
    },
    seatMap: {
      resolve: async (eventId, seatIds) => {
        resolves.push([eventId, seatIds]);
        return seatIds.map((id) => (id === o.missing ? undefined : REFS[id]));
      },
    },
  };
  return { src, pins, releases, resolves };
}

/** inventory의 좌석 Redis 장애(이름으로 가른다) */
function seatStoreUnavailable(): Error {
  const e = new Error('좌석 Redis 장애');
  e.name = 'SeatStoreUnavailable';
  return e;
}

describe('InventoryOrderSeatPins.pin', () => {
  test('FR011_좌석맵 판 resolve로 좌석 색인을 붙여(좌석 ID 오름차순) 묶기를 부르고, 구매 세션 ID는 jti 모양 그대로·마감을 넘긴다', async () => {
    const s = source();
    expect(await new InventoryOrderSeatPins(s.src).pin(pinInput(), { deadlineMs: 80 })).toEqual({ status: 'OK', gen: 3 });
    expect(s.resolves.map(([e, ids]) => [e, [...ids].sort()])).toEqual([[EVENT, [SEAT_1, SEAT_2]]]);
    expect(s.pins).toHaveLength(1);
    const [input, o] = s.pins[0]!;
    expect(input).toEqual({ eventId: EVENT, accountId: ACCOUNT, purchaseSessionId: SAGA_PSID, holdId: HOLD_ID, seats: [REFS[SEAT_1], REFS[SEAT_2]], limit: 4, orderGen: 3, keepUntilMs: NOW + 3 * DAY });
    expect(o).toEqual({ deadlineMs: 80 });
  });

  test.each<[PinResultShape, unknown]>([
    [{ kind: 'OK', gen: 5, regrabbed: 1, fencingToken: 99 }, { status: 'OK', gen: 5 }],
    [{ kind: 'NOT_READY' }, { status: 'NOT_READY' }],
    [{ kind: 'TAKEN', seatIndex: 10 }, { status: 'TAKEN' }],
    [{ kind: 'QUOTA_EXCEEDED' }, { status: 'QUOTA_EXCEEDED' }],
    [{ kind: 'STALE_GEN', gen: 4 }, { status: 'STALE_GEN', gen: 4 }],
    [{ kind: 'FAILED_HOLD' }, { status: 'FAILED_HOLD' }],
  ])('FR011_inventory 결과 %o → 주문 모습 %o(TAKEN의 색인·다시 잡은 수·토큰은 버린다)', async (pin, expected) => {
    expect(await new InventoryOrderSeatPins(source({ pin }).src).pin(pinInput())).toEqual(expected);
  });

  test('FR011_좌석맵 판에 없는 좌석이 하나라도 있으면 Error(설정 오류)이고 좌석 Redis를 부르지 않는다', async () => {
    const s = source({ missing: SEAT_1 });
    await expect(new InventoryOrderSeatPins(s.src).pin(pinInput())).rejects.toThrow(Error);
    await expect(new InventoryOrderSeatPins(s.src).pin(pinInput())).rejects.not.toThrow(/미구현/);
    expect(s.pins).toEqual([]);
  });

  test('FR011_inventory 좌석 Redis 장애(SeatStoreUnavailable)는 OrderSeatStoreUnavailable로 바꿔 던지고, 그 밖의 오류는 그대로다', async () => {
    await expect(new InventoryOrderSeatPins(source({ pin: seatStoreUnavailable() }).src).pin(pinInput())).rejects.toBeInstanceOf(OrderSeatStoreUnavailable);
    const other = new Error('PEAKET_CORRUPT_KEY');
    await expect(new InventoryOrderSeatPins(source({ pin: other }).src).pin(pinInput())).rejects.toBe(other);
  });
});

describe('InventoryOrderSeatPins.releaseFailed', () => {
  const release = { eventId: EVENT, accountId: ACCOUNT, holdId: HOLD_ID, seatIds: [SEAT_2, SEAT_1], keepUntilMs: NOW + 3 * DAY };

  test('FR011_좌석 색인을 붙여(좌석 ID 오름차순) 실패 해제를 부르고 { OK, released }·NOT_READY를 주문 모습으로 돌려준다', async () => {
    const s = source({ release: { kind: 'OK', released: 2 } });
    expect(await new InventoryOrderSeatPins(s.src).releaseFailed(release, { deadlineMs: 50 })).toEqual({ status: 'OK', released: 2 });
    expect(s.releases).toEqual([[{ eventId: EVENT, accountId: ACCOUNT, holdId: HOLD_ID, seats: [REFS[SEAT_1], REFS[SEAT_2]], keepUntilMs: NOW + 3 * DAY }, { deadlineMs: 50 }]]);
    expect(await new InventoryOrderSeatPins(source({ release: { kind: 'NOT_READY' } }).src).releaseFailed(release)).toEqual({ status: 'NOT_READY' });
  });

  test('FR011_좌석 Redis 장애는 OrderSeatStoreUnavailable, 좌석맵 판에 없는 좌석은 Error(부르지 않음)다', async () => {
    await expect(new InventoryOrderSeatPins(source({ release: seatStoreUnavailable() }).src).releaseFailed(release)).rejects.toBeInstanceOf(OrderSeatStoreUnavailable);
    const s = source({ missing: SEAT_2 });
    await expect(new InventoryOrderSeatPins(s.src).releaseFailed(release)).rejects.not.toThrow(/미구현/);
    expect(s.releases).toEqual([]);
  });
});

describe('SeatMapSagaConfigs', () => {
  test('FR011_좌석맵 판의 1인 한도·판매 종료 두 칸만 돌려주고, 판이 없거나 읽기가 던지면 undefined다(던지지 않는다)', async () => {
    const full = { perAccountLimit: 4, saleEndsAtMs: NOW + DAY, tierPrices: { R: 1 } };
    expect(await new SeatMapSagaConfigs({ config: async () => full }).get(EVENT)).toEqual({ perAccountLimit: 4, saleEndsAtMs: NOW + DAY });
    expect(await new SeatMapSagaConfigs({ config: async () => undefined }).get(EVENT)).toBeUndefined();
    expect(
      await new SeatMapSagaConfigs({
        config: async () => {
          throw new Error('layout read failed');
        },
      }).get(EVENT),
    ).toBeUndefined();
  });
});

describe('LoggerSagaLog', () => {
  const recording = () => {
    const lines: { level: 'warn' | 'error'; obj: Record<string, unknown> }[] = [];
    const logger = {
      warn: (obj: unknown) => void lines.push({ level: 'warn', obj: obj as Record<string, unknown> }),
      error: (obj: unknown) => void lines.push({ level: 'error', obj: obj as Record<string, unknown> }),
    };
    return { lines, log: new LoggerSagaLog(logger as never) };
  };

  test('FR011_releaseFailed는 warn 한 줄 { event order_saga_release_failed, orderId, eventId, why }이고 그 밖의 칸이 없다', () => {
    const r = recording();
    r.log.releaseFailed({ orderId: 'o1', eventId: EVENT, why: 'seat_store_unavailable', paymentKey: PAYMENT_KEY } as never);
    expect(r.lines).toEqual([{ level: 'warn', obj: { event: 'order_saga_release_failed', orderId: 'o1', eventId: EVENT, why: 'seat_store_unavailable' } }]);
  });

  test('FR011_confirmRejected는 error 한 줄 { kind config, event order_saga_confirm_rejected, orderId, reason, severity SEV2 }다', () => {
    const r = recording();
    r.log.confirmRejected({ orderId: 'o1', reason: 'permission_denied' });
    expect(r.lines).toEqual([{ level: 'error', obj: { kind: 'config', event: 'order_saga_confirm_rejected', orderId: 'o1', reason: 'permission_denied', severity: 'SEV2' } }]);
  });

  test('FR011_ADR0053_stepError는 error 한 줄 { event order_saga_step_error, orderId, step, err }이고, 받은 객체의 다른 칸(결제 키)은 싣지 않는다', () => {
    const r = recording();
    r.log.stepError({ orderId: 'o1', step: 'CONFIRM', err: new Error('db down'), paymentKey: PAYMENT_KEY } as never);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.level).toBe('error');
    expect(Object.keys(r.lines[0]!.obj).sort()).toEqual(['err', 'event', 'orderId', 'step']);
    expect(r.lines[0]!.obj).toMatchObject({ event: 'order_saga_step_error', orderId: 'o1', step: 'CONFIRM' });
    expect(JSON.stringify(r.lines)).not.toContain(PAYMENT_KEY);
  });

  test('FR011_리뷰 고침 M2_stepError의 err는 플랫폼 errorSummary다: Drizzle 쿼리 오류는 쿼리 틀과 SQLSTATE만 싣고 매개변수(params: …에 든 주문·좌석 UUID·결제 키)는 싣지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const r = recording();
    const query = 'update seat_sale set status = $1 where order_id = $2 and seat_id = any($3)';
    const err = new DrizzleQueryError(query, ['SOLD', HOLD_ID, [SEAT_1, SEAT_2], PAYMENT_KEY], Object.assign(new Error('could not serialize access'), { code: '40001' }));
    // 전제: 원래 오류 글에는 매개변수가 들어 있다
    expect(err.message).toContain(SEAT_1);
    r.log.stepError({ orderId: 'o1', step: 'RESERVE', err });
    r.log.stepError({ orderId: 'o2', step: 'CONFIRM', err: new TypeError('x') });
    expect(r.lines.map((l) => l.obj.err)).toEqual([`DrizzleQueryError: Failed query: ${query} (40001)`, 'TypeError: x']);
    const text = JSON.stringify(r.lines);
    for (const secret of [SEAT_1, SEAT_2, HOLD_ID, PAYMENT_KEY, 'params:']) expect(text, secret).not.toContain(secret);
  });

  test('FR011_로거가 던져도 삼킨다(부른 쪽을 막지 않는다)', () => {
    const throwing = { warn: () => { throw new Error('x'); }, error: () => { throw new Error('y'); } };
    const log = new LoggerSagaLog(throwing as never);
    expect(() => log.releaseFailed({ orderId: 'o1', eventId: EVENT, why: 'x' })).not.toThrow();
    expect(() => log.confirmRejected({ orderId: 'o1', reason: 'x' })).not.toThrow();
    expect(() => log.stepError({ orderId: 'o1', step: 'RESERVE', err: new Error('z') })).not.toThrow();
  });
});
