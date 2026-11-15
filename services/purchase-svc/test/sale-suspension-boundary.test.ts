// 판매 중지(SALE_STOP)·재개(SALE_RESUME)와 판매 일시정지(PAUSE)의 경계(ADR-0123, R-584, docs/features/transfer-refund.md §2.1).
// 두 상태는 다른 칸이다: 재개(RESUME)는 suspended만 내리고 paused는 건드리지 않는다.
// 제어 gRPC가 매긴 판 번호(version)는 늘어나기만 한다: 옛 판의 늦은 재개가 최신 중지를 되돌리면 안 된다.
import { describe, expect, test } from 'vitest';
import { MemorySaleControlCopies, MemorySaleControlStore, SetSaleSuspension } from '../src/modules/sale-control/index.js';

const NOW = Date.parse('2026-11-14T09:00:00.000Z');
const EVENT = '01900000-0000-7000-8000-000000000001';
const STOP = '01900000-0000-7000-8000-0000000000a1';
const RESUME = '01900000-0000-7000-8000-0000000000a2';
const LATE = '01900000-0000-7000-8000-0000000000a3';

const fixture = () => {
  const store = new MemorySaleControlStore();
  const copies = new MemorySaleControlCopies();
  return { store, copies, service: new SetSaleSuspension(store, copies) };
};

const suspend = (f: ReturnType<typeof fixture>, over: Record<string, unknown> = {}) =>
  f.service.run({ eventId: EVENT, action: 'SUSPEND', commandId: STOP, reason: '판매자 신원 확인', suspensionRef: 'AP-1', nowMs: NOW, ...over });
const resume = (f: ReturnType<typeof fixture>, over: Record<string, unknown> = {}) =>
  f.service.run({ eventId: EVENT, action: 'RESUME', commandId: RESUME, reason: '신원 확인 끝', nowMs: NOW + 1_000, ...over });

describe('SALE_STOP·SALE_RESUME 경계', () => {
  test('판 번호가 같거나 작은 재개는 최신 중지를 되돌리지 않는다(제어 gRPC 재전송)', async () => {
    const f = fixture();
    expect(await suspend(f, { version: 5 })).toEqual({ eventId: EVENT, suspended: true, revision: 5, changed: true });
    // 옛 판(5)의 늦은 재개: 같거나 작으면 무시한다
    expect(await resume(f, { version: 5 })).toEqual({ eventId: EVENT, suspended: true, revision: 5, changed: false });
    expect(await resume(f, { version: 4 })).toMatchObject({ suspended: true, revision: 5, changed: false });
    // 사본은 원본의 지금 값(중지)을 다시 쓴다: 앞선 시도가 Redis에 못 썼어도 여기서 맞춘다
    expect(f.copies.written.get(EVENT)).toMatchObject({ suspended: '1', rev: '5' });
    // 더 큰 판만 내린다
    expect(await resume(f, { version: 6 })).toMatchObject({ suspended: false, revision: 6, changed: true });
    expect(f.copies.written.get(EVENT)).toMatchObject({ suspended: '0', rev: '6' });
  });

  test('판 번호가 없는 HTTP 경로는 저장소가 판을 하나 올린다', async () => {
    const f = fixture();
    expect(await suspend(f)).toMatchObject({ suspended: true, revision: 1, changed: true });
    expect(await resume(f)).toMatchObject({ suspended: false, revision: 2, changed: true });
    expect(await suspend(f, { commandId: LATE })).toMatchObject({ suspended: true, revision: 3, changed: true });
  });

  test('재개는 판매 일시정지(paused)를 건드리지 않는다', async () => {
    const f = fixture();
    // 명령 3(판매 일시정지)이 이미 paused를 세운 행
    f.store.rows.set(EVENT, { eventId: EVENT, paused: true, suspended: false, revision: 5, updatedAtMs: NOW });
    expect(await suspend(f, { version: 6 })).toMatchObject({ suspended: true, revision: 6, changed: true });
    expect(f.store.rows.get(EVENT)).toMatchObject({ paused: true, suspended: true });
    expect(await resume(f, { version: 7 })).toMatchObject({ suspended: false, revision: 7, changed: true });
    // 재개로 paused가 풀리면 판매 일시정지가 풀린다(다른 칸이어야 한다)
    expect(f.store.rows.get(EVENT)).toMatchObject({ paused: true, suspended: false });
    expect(await f.service.state(EVENT)).toEqual({ eventId: EVENT, suspended: false, revision: 7 });
  });

  test('같은 명령·같은 상태의 재시도는 판을 올리지 않고, 같은 명령이라도 상태가 다르면 올린다', async () => {
    const f = fixture();
    expect(await suspend(f)).toMatchObject({ suspended: true, revision: 1, changed: true });
    expect(await suspend(f, { nowMs: NOW + 500 })).toMatchObject({ suspended: true, revision: 1, changed: false });
    // 같은 명령 ID라도 상태가 다르면 새 쓰기다(재시도가 아니라 다른 뜻)
    expect(await f.service.run({ eventId: EVENT, action: 'RESUME', commandId: STOP, reason: '같은 명령 ID', nowMs: NOW + 600 })).toMatchObject({ suspended: false, revision: 2, changed: true });
    // 다른 명령이 같은 상태를 다시 쓰면 판을 올린다
    expect(await suspend(f, { commandId: LATE, nowMs: NOW + 700 })).toMatchObject({ suspended: true, revision: 3, changed: true });
  });

  test('행이 없으면 정지가 아니고, 사본 쓰기가 실패하면 명령은 실패로 남도록 던진다', async () => {
    const f = fixture();
    expect(await f.service.state(EVENT)).toEqual({ eventId: EVENT, suspended: false, revision: 0 });
    const failing = new SetSaleSuspension(f.store, {
      write: async () => {
        throw new Error('redis unavailable');
      },
    });
    await expect(failing.run({ eventId: EVENT, action: 'SUSPEND', commandId: STOP, reason: '법적 요청', nowMs: NOW })).rejects.toThrow('redis unavailable');
    // 원본은 이미 바뀌었다: 재시도(같은 명령 ID)가 사본을 다시 쓴다
    expect(f.store.rows.get(EVENT)).toMatchObject({ suspended: true, revision: 1 });
    expect(await suspend(f, { nowMs: NOW + 1 })).toMatchObject({ suspended: true, revision: 1, changed: false });
    expect(f.copies.written.get(EVENT)).toMatchObject({ suspended: '1', rev: '1' });
  });
});
