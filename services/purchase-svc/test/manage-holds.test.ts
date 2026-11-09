// 홀드 다시 읽기·해제·연장 쓰임새의 단위 시험(docs/features/seat-hold.md §5 '해제·연장·다시 읽기와 결제 정지 멈춤의 첫 구현', S-T29·S-T33·S-T6·S-T23, BUILD_ORDER HOT-070·HOT-358 리뷰 V1).
// 좌석 Redis Lua의 판정은 test-int/hold-lifecycle.int.test.ts가 본다. 여기서는 Lua 밖에서 쓰임새가 정하는 것을 본다: 세션 소유·입장 토큰 계정 대조, 결과 → 오류 코드, 응답 칸, 해제 뒤 처리.
import { fakeClock } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import { HoldError, type HoldTarget, ManageHolds, MemorySeatMap } from '../src/modules/inventory/index.js';
import { claimsOf, ISS, newKey, signAdmission } from './admission-fixtures.js';

const NOW = Date.parse('2026-11-10T03:00:00.000Z');
const EVENT = 'ev-manage-1';
const ME = 'acct-me';
const OTHER = 'acct-other';
const JTI = 'ps-1';
const HOLD = 'hold-1';
const R_PRICE = 150_000;
const S_PRICE = 90_000;
const key = newKey('k1');
const keys = new Map([['k1', key.pub]]);

const seatMap = new MemorySeatMap();
seatMap.put(
  { eventId: EVENT, layoutVersion: 'v1', seatCount: 2, perAccountLimit: 4, saleEndsAtMs: NOW + 86_400_000, tierPrices: { R: R_PRICE, S: S_PRICE }, tierNames: { R: 'R석', S: 'S석' } },
  [
    { seatId: 'A01', index: 0, sectionId: 'A', sectionIndex: 0, seatOffset: 0, tierId: 'R', label: 'A구역 1번' },
    { seatId: 'B01', index: 1, sectionId: 'B', sectionIndex: 1, seatOffset: 0, tierId: 'S', label: 'B구역 1번' },
  ],
);

interface Fx {
  session: { accountId: string; eventId: string; maxStayUntilMs: number } | undefined;
  listed: string | null;
  readResult: unknown;
  releaseResult: unknown;
  extendResult: unknown;
  calls: { op: string; target?: HoldTarget; maxStayMs?: number }[];
  forgotten: { jti: string; holdId: string }[];
  released: { eventId: string; holdIds: readonly string[] }[];
}
let fx: Fx;
let uc: ManageHolds;

beforeEach(() => {
  fx = {
    session: { accountId: ME, eventId: EVENT, maxStayUntilMs: NOW + 2_700_000 },
    listed: 'A01,B01',
    readResult: { kind: 'OK', expiresAtMs: NOW + 420_000, extended: false, fencingToken: 7, frozen: false },
    releaseResult: { kind: 'OK', released: 2 },
    extendResult: { kind: 'OK', expiresAtMs: NOW + 600_000, fencingToken: 7 },
    calls: [],
    forgotten: [],
    released: [],
  };
  uc = new ManageHolds({
    lifecycle: {
      read: async (t: HoldTarget) => (fx.calls.push({ op: 'read', target: t }), fx.readResult),
      release: async (t: HoldTarget) => (fx.calls.push({ op: 'release', target: t }), fx.releaseResult),
      extend: async (t: HoldTarget) => (fx.calls.push({ op: 'extend', target: t }), fx.extendResult),
      markOrdered: async (t: HoldTarget, maxStayMs: number) => (fx.calls.push({ op: 'mark', target: t, maxStayMs }), { kind: 'OK', added: 1 }),
    } as never,
    seatMap,
    sessions: {
      read: async () => fx.session,
      heldSeats: async () => fx.listed,
      sessionHolds: async () => [],
      forgetHold: async (jti: string, holdId: string) => void fx.forgotten.push({ jti, holdId }),
    } as never,
    keys,
    issuer: ISS,
    clock: fakeClock({ now: NOW }),
    onReleased: (e) => void fx.released.push(e),
  });
});

const tokenFor = (accountId: string) => signAdmission(key, claimsOf({ nowMs: NOW, jti: JTI, accountId, eventId: EVENT }));
const code = async (p: Promise<unknown>) => p.then(() => 'OK', (e: unknown) => (e instanceof HoldError ? e.code : `던짐: ${String(e)}`));
const action = { accountId: ME, purchaseSessionId: JTI, holdId: HOLD };
const luaCalls = () => fx.calls.map((c) => c.op);

describe('소유 확인 S-T29', () => {
  test('S-T29 구매 세션이 다른 계정의 것이면 해제·연장 모두 SESSION_NOT_FOUND이고 Lua를 부르지 않는다', async () => {
    fx.session = { accountId: OTHER, eventId: EVENT, maxStayUntilMs: NOW + 1 };
    expect(await code(uc.release(action))).toBe('SESSION_NOT_FOUND');
    expect(await code(uc.extend(action))).toBe('SESSION_NOT_FOUND');
    expect(luaCalls()).toEqual([]);
  });
  test('S-T29 ② 구매 세션의 목록에 없는 holdId는 HOLD_NOT_FOUND이고 Lua를 부르지 않는다', async () => {
    fx.listed = null;
    expect(await code(uc.release(action))).toBe('HOLD_NOT_FOUND');
    expect(await code(uc.extend(action))).toBe('HOLD_NOT_FOUND');
    expect(luaCalls()).toEqual([]);
  });
  test('S-T29 다시 읽기: 입장 토큰의 계정이 요청 계정과 다르면 ADMISSION_INVALID이고 세션·Lua를 보지 않는다', async () => {
    fx.session = { accountId: OTHER, eventId: EVENT, maxStayUntilMs: NOW + 1 };
    expect(await code(uc.read({ token: tokenFor(OTHER), accountId: ME, holdId: HOLD }))).toBe('ADMISSION_INVALID');
    expect(luaCalls()).toEqual([]);
  });
  test('S-T29 다시 읽기: 토큰은 내 것이어도 세션이 다른 계정의 것이면 SESSION_NOT_FOUND다', async () => {
    fx.session = { accountId: OTHER, eventId: EVENT, maxStayUntilMs: NOW + 1 };
    expect(await code(uc.read({ token: tokenFor(ME), accountId: ME, holdId: HOLD }))).toBe('SESSION_NOT_FOUND');
    expect(luaCalls()).toEqual([]);
  });
  test('S-T29 Lua에는 계정·구매 세션·holdId와 세션에 적힌 좌석만 넘긴다', async () => {
    await uc.extend(action);
    expect(fx.calls[0]!.target).toMatchObject({ eventId: EVENT, accountId: ME, purchaseSessionId: JTI, holdId: HOLD });
    expect(fx.calls[0]!.target!.seats.map((s) => s.seatId)).toEqual(['A01', 'B01']);
  });
});

describe('Lua 결과 → 오류 코드', () => {
  test.each([
    ['NOT_READY', 'NOT_READY'],
    ['NOT_FOUND', 'HOLD_NOT_FOUND'],
    ['PINNED', 'HOLD_IN_PAYMENT'],
  ])('해제 %s는 %s다', async (kind, want) => {
    fx.releaseResult = { kind };
    expect(await code(uc.release(action))).toBe(want);
  });
  test.each([
    ['NOT_READY', 'NOT_READY'],
    ['NOT_FOUND', 'HOLD_NOT_FOUND'],
    ['PINNED', 'HOLD_IN_PAYMENT'],
    ['ALREADY', 'HOLD_ALREADY_EXTENDED'],
  ])('S-T6 연장 %s는 %s다', async (kind, want) => {
    fx.extendResult = { kind };
    expect(await code(uc.extend(action))).toBe(want);
  });
  test('다시 읽기 NOT_FOUND는 HOLD_NOT_FOUND다', async () => {
    fx.readResult = { kind: 'NOT_FOUND' };
    expect(await code(uc.read({ token: tokenFor(ME), accountId: ME, holdId: HOLD }))).toBe('HOLD_NOT_FOUND');
  });
});

describe('응답 칸', () => {
  test('S-T6 연장 응답은 extendable false이고 새 만료·토큰을 싣는다', async () => {
    const b = await uc.extend(action);
    expect(b).toMatchObject({ holdId: HOLD, seatIds: ['A01', 'B01'], expiresAt: new Date(NOW + 600_000).toISOString(), extendable: false, fencingToken: 7 });
  });
  test('S-T6 다시 읽기: 아직 연장하지 않았으면 extendable true, 연장했으면 false다', async () => {
    expect((await uc.read({ token: tokenFor(ME), accountId: ME, holdId: HOLD })).extendable).toBe(true);
    fx.readResult = { kind: 'OK', expiresAtMs: NOW + 420_000, extended: true, fencingToken: 7, frozen: false };
    expect((await uc.read({ token: tokenFor(ME), accountId: ME, holdId: HOLD })).extendable).toBe(false);
  });
  test('S-T23 다시 읽기: 멈춘 홀드만 frozen 칸이 참이고, 아니면 칸이 없다', async () => {
    expect(await uc.read({ token: tokenFor(ME), accountId: ME, holdId: HOLD })).not.toHaveProperty('frozen');
    fx.readResult = { kind: 'OK', expiresAtMs: NOW + 420_000, extended: false, fencingToken: 7, frozen: true };
    expect((await uc.read({ token: tokenFor(ME), accountId: ME, holdId: HOLD })).frozen).toBe(true);
  });
  test('좌석이 여럿이면 totalAmount는 좌석 정가의 합이고 좌석마다 이름·등급 이름·정가를 싣는다', async () => {
    const b = await uc.read({ token: tokenFor(ME), accountId: ME, holdId: HOLD });
    expect(b.totalAmount).toBe(R_PRICE + S_PRICE);
    expect(b.seats).toEqual([
      { seatId: 'A01', label: 'A구역 1번', tierId: 'R', tierName: 'R석', price: R_PRICE },
      { seatId: 'B01', label: 'B구역 1번', tierId: 'S', tierName: 'S석', price: S_PRICE },
    ]);
  });
});

describe('해제 뒤 처리 S-T33', () => {
  test('S-T33 해제하면 세션의 h: 칸을 지우고 주문 만료 고리를 그 홀드로 한 번 부른다', async () => {
    await uc.release(action);
    await Promise.resolve();
    expect(fx.forgotten).toEqual([{ jti: JTI, holdId: HOLD }]);
    expect(fx.released).toEqual([{ eventId: EVENT, holdIds: [HOLD] }]);
  });
  test('S-T33 풀지 못했으면(NOT_FOUND·PINNED) 세션 칸을 지우지 않고 고리도 부르지 않는다', async () => {
    fx.releaseResult = { kind: 'PINNED' };
    await code(uc.release(action));
    expect(fx.forgotten).toEqual([]);
    expect(fx.released).toEqual([]);
  });
});

describe('세션 끝 해제', () => {
  test('S-T33 ⑥ 좌석맵 판에 없는 좌석이 있는 홀드는 Lua를 부르지 않고 경고도 없이 건너뛴다(그 홀드는 만료로 풀린다)', async () => {
    const warned: unknown[] = [];
    const d = new ManageHolds({
      lifecycle: { release: async (t: HoldTarget) => (fx.calls.push({ op: 'release', target: t }), { kind: 'OK', released: 1 }) } as never,
      seatMap,
      sessions: { forgetHold: async () => undefined } as never,
      keys,
      issuer: ISS,
      clock: fakeClock({ now: NOW }),
      logger: { warn: (...a: unknown[]) => void warned.push(a) } as never,
    });
    await d.releaseEntries({ eventId: EVENT, accountId: ME, sessionId: JTI, holds: [{ holdId: HOLD, seatIds: ['Z99'] }], reason: 'left' });
    expect(luaCalls()).toEqual([]);
    expect(warned).toEqual([]);
  });
});

describe('주문 표시', () => {
  test('S-T23 ③ 주문 표시는 세션의 최대 체류 시각을 넘긴다', async () => {
    expect(await uc.markOrdered({ eventId: EVENT, accountId: ME, sessionId: JTI, holdId: HOLD, seatIds: ['A01'] })).toBe(true);
    expect(fx.calls[0]).toMatchObject({ op: 'mark', maxStayMs: NOW + 2_700_000 });
  });
  test('세션이 없으면 표시하지 않고 거짓이다(201은 그대로)', async () => {
    fx.session = undefined;
    expect(await uc.markOrdered({ eventId: EVENT, accountId: ME, sessionId: JTI, holdId: HOLD, seatIds: ['A01'] })).toBe(false);
    expect(luaCalls()).toEqual([]);
  });
});
