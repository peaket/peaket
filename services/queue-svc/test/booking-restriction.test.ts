// Q-T59 예매 제한 쓰기 경로 시험(queue-svc, GAT-310).
import { describe, expect, test } from 'vitest';
import { MemoryBookingRestrictions, bookingRestrictionHandlers, bookingRestricted } from '../src/modules/admission/index.js';

const A = '01900000-0000-7000-8000-000000000001';

describe('Q-T59 queue-svc SetBookingRestriction', () => {
  test('판 번호가 클 때만 ACTIVE/LIFTED를 반영하고 옛 판은 changed false다', async () => {
    const store = new MemoryBookingRestrictions();
    expect(await store.apply({ accountId: A, restrictionId: 'r1', state: 'ACTIVE', untilMs: 1_000, version: 1 })).toEqual({ changed: true });
    expect(store.rows.get(A)).toMatchObject({ st: 'ACTIVE', untilMs: 1_000, rid: 'r1', ver: 1 });
    expect(bookingRestricted(store.rows.get(A), 999)).toBe(true);
    expect(bookingRestricted(store.rows.get(A), 1_000)).toBe(false);
    expect(await store.apply({ accountId: A, restrictionId: 'r1', state: 'ACTIVE', version: 1 })).toEqual({ changed: false });
    expect(await store.apply({ accountId: A, restrictionId: 'r1', state: 'LIFTED', version: 2 })).toEqual({ changed: true });
    expect(store.rows.get(A)).toMatchObject({ st: 'LIFTED', rid: 'r1', ver: 2 });
    expect(store.rows.get(A)?.untilMs).toBeUndefined();
  });

  test('gRPC 요청 모양을 읽고 모양이 틀리면 INVALID_ARGUMENT다', async () => {
    const store = new MemoryBookingRestrictions();
    const handlers = bookingRestrictionHandlers({ apply: (i) => store.apply(i) }, () => undefined) as unknown as {
      SetBookingRestriction: (call: { request: Record<string, unknown> }, cb: (e: unknown, v?: unknown) => void) => void;
    };
    const call = (request: Record<string, unknown>) =>
      new Promise<{ e: unknown; v?: unknown }>((resolve) => handlers.SetBookingRestriction({ request }, (e, v) => resolve({ e, v })));
    const ok = await call({ account_id: A, restriction_id: 'r1', state: 'BOOKING_RESTRICTION_STATE_ACTIVE', version: 3, ends_at: { seconds: 10, nanos: 0 } });
    expect(ok.e).toBeNull();
    expect(ok.v).toEqual({ changed: true });
    expect(store.rows.get(A)).toMatchObject({ st: 'ACTIVE', untilMs: 10_000, ver: 3 });
    const bad = await call({ account_id: 'not-a-uuid', restriction_id: 'r1', state: 'BOOKING_RESTRICTION_STATE_ACTIVE', version: 4 });
    expect(bad.e).toMatchObject({ code: 3 });
  });
});
