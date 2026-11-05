// 새 홀드의 구매 세션 기록과 첫 홀드 표시(BUILD_ORDER PRF-137, docs/features/seat-hold.md §3 '구매 세션의 홀드 기록과 첫 홀드 표시', S-T35, ADR-0171).
// HoldSeats가 홀드 Lua가 새로 잡은 뒤(OK. 멱등 재생은 제외) SessionHolds.recordHold(구매 세션 ID, holdId, 정렬한 좌석 ID들)를 한 번 부르고,
// 그 결과를 시도 기록 HELD의 firstHeldInSession으로 싣는다. 실패해도 홀드는 성공이다(보조 기록: 정본은 홀드 Hash의 owner·holdId).
// 앱 쪽 시각은 모두 주입한 가짜 시계, 저장소는 메모리 구현이다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Deadline, fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  HoldError,
  type HoldCommand,
  type HoldAttemptRecord,
  HoldSeats,
  KEEP_AFTER_SALE_END_MS,
  MemoryPurchaseSessions,
  MemoryPurchaseSessionStore,
  MemorySeatMap,
  MemorySeatStore,
  noSeatSignals,
  RecordingHoldAttempts,
  type SessionHolds,
  SeatStoreUnavailable,
} from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, newEvent, ref, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';
import { openInput } from './purchase-session-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const KEY = Buffer.alloc(32, 7);
const JNY_A = '0190f3a1-7c2e-7a00-8000-0000000000aa';
const JNY_B = '0190f3a1-7c2e-7a00-8000-0000000000bb';

interface WorldOptions {
  limit?: number;
  /** HoldSeats에 holds(SESSION_HOLDS)를 주지 않는다 */
  noHolds?: boolean;
  /** 구매 세션 저장소에 세션을 열지 않는다(플랫폼 훅 대역에만 있다: recordHold는 세션 없음 null) */
  noStoreSession?: boolean;
  /** recordHold 대역(기본은 메모리 구매 세션 저장소) */
  recordHold?: () => Promise<boolean | null>;
  /** 홀드 Lua가 끝난 뒤 가짜 시계를 이만큼(ms) 보낸다(홀드가 걸린 시간) */
  holdTakes?: number;
}

/** HoldSeats에 넘기는 서비스 로거 대역: warn 호출을 모은다 */
interface WarnCall {
  obj: Record<string, unknown>;
  msg: string;
}

async function world(o: WorldOptions = {}) {
  const clock = fakeClock({ now: NOW, monotonic: 50 });
  const inner = new MemorySeatStore(clock);
  const seatMap = new MemorySeatMap();
  const sessions = new MemoryPurchaseSessions();
  const attempts = new RecordingHoldAttempts();
  const sessionStore = new MemoryPurchaseSessionStore(clock);
  const eventId = newEvent();
  const saleEndsAtMs = NOW + DAY;
  seatMap.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: o.limit ?? 4, saleEndsAtMs }, SEAT_DEFS);
  await inner.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: saleEndsAtMs + KEEP_AFTER_SALE_END_MS });
  const opens: Array<[string, string, string, string]> = [
    ['ps-a', ACCOUNT_A, 'ls-a', JNY_A],
    ['ps-b', ACCOUNT_B, 'ls-b', JNY_B],
  ];
  for (const [sessionId, accountId, loginSessionId, journeyId] of opens) {
    sessions.open({ sessionId, accountId, eventId, journeyId, loginSessionId, key: KEY });
    if (!o.noStoreSession) expect((await sessionStore.open(openInput(clock, sessionId, { accountId, loginSessionId, eventId, journeyId }))).kind).toBe('CREATED');
  }
  /** recordHold 호출(부른 차례) */
  const calls: Array<{ jti: string; holdId: string; seatIds: string[] }> = [];
  /** recordHold의 넷째 인자(호출 마감 선택값)를 부른 차례대로 */
  const opts: unknown[] = [];
  const warns: WarnCall[] = [];
  const logger = { warn: (obj: object, msg: string) => warns.push({ obj: obj as Record<string, unknown>, msg }) };
  const holds: SessionHolds = {
    recordHold: async (jti, holdId, seatIds, opt) => {
      calls.push({ jti, holdId, seatIds: [...seatIds] });
      opts.push(opt);
      return o.recordHold ? o.recordHold() : sessionStore.recordHold(jti, holdId, seatIds);
    },
  };
  if (o.holdTakes) {
    const hold = inner.hold.bind(inner);
    inner.hold = async (i, opt) => {
      const r = await hold(i, opt);
      clock.advance(o.holdTakes!);
      return r;
    };
  }
  const uc = new HoldSeats(inner, seatMap, sessions, attempts, clock, noSeatSignals, o.noHolds ? undefined : holds, logger as never);
  const run = (seatIds: readonly string[], c: Partial<HoldCommand> = {}) =>
    uc.execute({ eventId, accountId: ACCOUNT_A, purchaseSessionId: 'ps-a', idempotencyKey: randomUUID(), body: { seatIds }, ...c });
  const asB = (seatIds: readonly string[], c: Partial<HoldCommand> = {}) => run(seatIds, { accountId: ACCOUNT_B, purchaseSessionId: 'ps-b', ...c });
  return { clock, inner, sessionStore, calls, opts, warns, attempts, eventId, uc, run, asB, ev: () => inner.db.event(eventId) };
}

/** 시도 기록의 firstHeldInSession 칸이 없는지(값 undefined로 남은 칸도 없는 것이다) */
const hasNoFirstHeld = (a: HoldAttemptRecord) => expect(Object.keys(a)).not.toContain('firstHeldInSession');

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(HoldError);
  expect((e as HoldError).code).toBe(code);
}

describe('HoldSeats: 새 홀드의 구매 세션 기록', () => {
  test('ST35_ADR0171_새 홀드 OK마다 recordHold(구매 세션 ID, holdId, 정렬한 좌석 ID들)를 한 번 부르고, 시도 기록 HELD에 첫 홀드는 firstHeldInSession true·둘째 새 홀드는 false가 실린다', async () => {
    const w = await world();
    const first = await w.run(['A02', 'A01']);
    expect(w.calls).toEqual([{ jti: 'ps-a', holdId: first.holdId, seatIds: ['A01', 'A02'] }]);
    expect(first.seatIds).toEqual(['A01', 'A02']);
    expect(w.attempts.records).toHaveLength(1);
    expect(w.attempts.records[0]).toMatchObject({ result: 'HELD', purchaseSessionId: 'ps-a', seatIds: ['A02', 'A01'], heldAtMs: NOW, firstHeldInSession: true });

    const second = await w.run(['B03']);
    expect(w.calls).toHaveLength(2);
    expect(w.calls[1]).toEqual({ jti: 'ps-a', holdId: second.holdId, seatIds: ['B03'] });
    expect(w.attempts.records[1]).toMatchObject({ result: 'HELD', firstHeldInSession: false });
    // 구매 세션 상태에는 홀드마다 좌석 ID들이 남는다
    expect(w.sessionStore.holdsOf('ps-a')).toEqual(
      new Map([
        [first.holdId, ['A01', 'A02']],
        [second.holdId, ['B03']],
      ]),
    );
  });

  test('ST35_첫 홀드 표시는 구매 세션마다 따로다: 다른 계정의 구매 세션도 첫 새 홀드는 true이고, 기록은 각자의 세션에 남는다', async () => {
    const w = await world();
    await w.run(['A01']);
    const b = await w.asB(['A05']);
    expect(w.attempts.records.map((a) => [a.purchaseSessionId, a.result, a.firstHeldInSession])).toEqual([
      ['ps-a', 'HELD', true],
      ['ps-b', 'HELD', true],
    ]);
    expect(w.calls.map((c) => c.jti)).toEqual(['ps-a', 'ps-b']);
    expect(w.sessionStore.holdsOf('ps-b')).toEqual(new Map([[b.holdId, ['A05']]]));
  });

  test('ST35_기록은 좌석 Redis 홀드가 끝난 뒤의 새 홀드에서만 한 번 부른다: 한 홀드는 좌석이 여럿이어도 recordHold 한 번, holdId는 응답의 holdId다', async () => {
    const w = await world();
    const r = await w.run(['A03', 'A01', 'B02', 'A02']);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toEqual({ jti: 'ps-a', holdId: r.holdId, seatIds: ['A01', 'A02', 'A03', 'B02'] });
    expect(w.sessionStore.holdsOf('ps-a')?.get(r.holdId)).toEqual(['A01', 'A02', 'A03', 'B02']);
  });

  test('ST24_ST35_멱등 재생(IDEM_REPLAY)은 기록하지 않는다: recordHold를 다시 부르지 않고 시도 기록도 늘지 않는다(기존 규칙)', async () => {
    const w = await world();
    const key = randomUUID();
    const first = await w.run(['A01', 'A02'], { idempotencyKey: key });
    const again = await w.run(['A02', 'A01'], { idempotencyKey: key });
    expect(again).toEqual(first);
    expect(w.calls).toHaveLength(1);
    expect(w.attempts.records).toHaveLength(1);
    expect(w.attempts.records[0]).toMatchObject({ result: 'HELD', firstHeldInSession: true });
    expect(w.sessionStore.holdsOf('ps-a')?.size).toBe(1);
  });

  test('ST35_거절(CONFLICT·QUOTA_EXCEEDED·REHOLD_WAIT·INVALID_SEAT)은 기록하지 않는다: recordHold를 부르지 않고 시도 기록에 firstHeldInSession 칸이 없다. 첫 홀드 표시도 쓰이지 않아 뒤의 첫 새 홀드가 true다', async () => {
    const w = await world({ limit: 2 });
    await w.asB(['A01']); // B의 첫 홀드
    expect(w.calls).toHaveLength(1);
    await rejects(w.run(['A01']), 'CONFLICT');
    await rejects(w.run(['A02', 'A03', 'A04']), 'QUOTA_EXCEEDED');
    w.ev().rel.set(ACCOUNT_A, new Map([[ref('A06').index, NOW + 30_000]]));
    await rejects(w.run(['A06']), 'REHOLD_WAIT');
    await rejects(w.run(['Z99']), 'INVALID_SEAT');
    expect(w.calls).toHaveLength(1);
    const mine = w.attempts.records.filter((a) => a.accountId === ACCOUNT_A);
    expect(mine.map((a) => a.result)).toEqual(['CONFLICT', 'LIMIT', 'RECENTLY_RELEASED', 'ERROR']);
    for (const a of mine) hasNoFirstHeld(a);
    expect(w.sessionStore.holdsOf('ps-a')).toBeUndefined();
    // 거절이 첫 홀드를 가져가지 않았다
    await w.run(['A02']);
    expect(w.attempts.records.at(-1)).toMatchObject({ accountId: ACCOUNT_A, result: 'HELD', firstHeldInSession: true });
  });

  test('ST35_recordHold가 null(구매 세션 상태가 없음: 끝났거나 키가 사라짐)이면 홀드는 201로 성공하고 시도 기록 HELD에 firstHeldInSession 칸이 없다', async () => {
    const w = await world({ noStoreSession: true });
    const r = await w.run(['A01']);
    expect(r.seatIds).toEqual(['A01']);
    expect(w.calls).toHaveLength(1);
    expect(w.attempts.records).toHaveLength(1);
    expect(w.attempts.records[0]).toMatchObject({ result: 'HELD', heldAtMs: NOW });
    hasNoFirstHeld(w.attempts.records[0]!);
    expect(w.ev().bits.has(ref('A01').index)).toBe(true);
  });

  test('ST35_recordHold가 SeatStoreUnavailable(일시 장애·메모리 부족)을 던져도 홀드는 201로 성공하고 던지지 않으며, 시도 기록 HELD에는 firstHeldInSession 칸이 없다 [ASVS v5.0.0-16.2.5]', async () => {
    for (const reason of ['unavailable', 'oom'] as const) {
      const w = await world({
        recordHold: async () => {
          throw new SeatStoreUnavailable(new Error('down s:session:{ps-a}'), reason);
        },
      });
      const r = await w.run(['A01', 'A02']);
      expect(r.seatIds, reason).toEqual(['A01', 'A02']);
      expect(w.calls, reason).toHaveLength(1);
      expect(w.attempts.records.map((a) => a.result), reason).toEqual(['HELD']);
      hasNoFirstHeld(w.attempts.records[0]!);
      expect(w.ev().bits.has(ref('A01').index), reason).toBe(true);
      expect(w.ev().quota.get(ACCOUNT_A), reason).toBe(2);
    }
  });

  test('ST35_recordHold가 일시 장애가 아닌 오류(Error)를 던져도 보조 기록이라 홀드는 성공하고 던지지 않는다. 시도 기록에 firstHeldInSession 칸이 없고, 같은 멱등 키 재시도는 재생이라 다시 기록하지 않는다', async () => {
    const w = await world({
      recordHold: async () => {
        throw new Error('ERR PEAKET_CORRUPT_KEY s:session:{ps-a}');
      },
    });
    const key = randomUUID();
    const r = await w.run(['A01'], { idempotencyKey: key });
    expect(r.seatIds).toEqual(['A01']);
    expect(w.calls).toHaveLength(1);
    expect(w.attempts.records.map((a) => a.result)).toEqual(['HELD']);
    hasNoFirstHeld(w.attempts.records[0]!);
    expect(w.attempts.records[0]).toMatchObject({ heldAtMs: NOW });
    expect(await w.run(['A01'], { idempotencyKey: key })).toEqual(r);
    expect(w.calls).toHaveLength(1);
    expect(w.attempts.records).toHaveLength(1);
  });

  test('ST35_holds(SESSION_HOLDS)를 주지 않으면 기록 없이 기존대로 동작한다: 홀드는 성공하고 시도 기록에 firstHeldInSession 칸이 없다', async () => {
    const w = await world({ noHolds: true });
    const r = await w.run(['A01', 'B01']);
    expect(r.seatIds).toEqual(['A01', 'B01']);
    expect(w.calls).toHaveLength(0);
    expect(w.attempts.records).toHaveLength(1);
    expect(w.attempts.records[0]).toMatchObject({ result: 'HELD', heldAtMs: NOW, tierId: 'R', sectionId: 'SEC-A' });
    hasNoFirstHeld(w.attempts.records[0]!);
    expect(w.sessionStore.holdsOf('ps-a')).toBeUndefined();
  });

  test('ST35_기록 결과가 시도 기록의 다른 칸을 바꾸지 않는다: 잡은 시각·등급·구역·걸린 시간·여정 ID는 기록이 없을 때와 같다', async () => {
    const withHolds = await world();
    const without = await world({ noHolds: true });
    await withHolds.run(['B02', 'A01']);
    await without.run(['B02', 'A01']);
    const { firstHeldInSession, ...rest } = withHolds.attempts.records[0]!;
    expect(firstHeldInSession).toBe(true);
    const { eventId: e1, ...restWithout } = without.attempts.records[0]!;
    const { eventId: e0, ...restWith } = rest;
    expect(e0).toBe(withHolds.eventId);
    expect(e1).toBe(without.eventId);
    expect(restWith).toEqual(restWithout);
  });
});

describe('기록 실패의 경고 로그(구매 세션 ID·키 이름을 싣지 않는다)', () => {
  test('ST35_recordHold가 던지면 서비스 로그 warn 한 줄(errorName만)을 남기고 구매 세션 ID·키 이름·오류 글은 싣지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const downs: Array<[unknown, string]> = [
      [new SeatStoreUnavailable(new Error('down s:session:{ps-a}'), 'oom'), 'SeatStoreUnavailable'],
      [new Error('ERR PEAKET_CORRUPT_KEY s:session:{ps-a}'), 'Error'],
    ];
    for (const [err, errorName] of downs) {
      const w = await world({
        recordHold: async () => {
          throw err;
        },
      });
      await w.run(['A01']);
      expect(w.warns, errorName).toHaveLength(1);
      expect(w.warns[0], errorName).toEqual({ obj: { errorName }, msg: '구매 세션의 홀드 기록 실패' });
      const text = JSON.stringify(w.warns);
      for (const secret of ['ps-a', 's:session', 'PEAKET_CORRUPT_KEY', 'down']) expect(text, errorName).not.toContain(secret);
    }
  });

  test('ST35_기록이 성공하거나 세션이 없어 null이거나 멱등 재생이거나 holds가 없으면 경고를 남기지 않는다', async () => {
    const ok = await world();
    const key = randomUUID();
    await ok.run(['A01'], { idempotencyKey: key });
    await ok.run(['A01'], { idempotencyKey: key }); // 멱등 재생
    expect(ok.warns).toEqual([]);
    const none = await world({ noStoreSession: true });
    await none.run(['A02']);
    expect(none.warns).toEqual([]);
    const off = await world({ noHolds: true });
    await off.run(['A03']);
    expect(off.warns).toEqual([]);
  });
});

describe('기록 호출은 요청의 마감 안에서 짧은 상한으로 부른다(홀드 p99 50ms 예산, guidelines §5)', () => {
  test('NFR003_마감이 없으면 { deadlineMs: 20 }을, 마감이 있으면 min(남은 시간, 20)을 내림한 정수(1 이상)를 넷째 인자로 준다', async () => {
    const none = await world();
    await none.run(['A01']);
    expect(none.opts[0]).toEqual({ deadlineMs: 20 });

    const roomy = await world();
    await roomy.run(['A02'], { deadline: Deadline.after(80, roomy.clock) });
    expect(roomy.opts[0]).toEqual({ deadlineMs: 20 });

    const tight = await world();
    await tight.run(['A03'], { deadline: Deadline.after(12, tight.clock) });
    expect(tight.opts[0]).toEqual({ deadlineMs: 12 });
  });

  test('NFR003_홀드가 끝난 뒤 남은 시간이 5ms 미만이면 기록 호출을 하지 않고 홀드는 201로 성공하며 firstHeldInSession 칸이 없다', async () => {
    const w = await world({ holdTakes: 3 });
    const r = await w.run(['A01'], { deadline: Deadline.after(6, w.clock) }); // 홀드 호출 앞 남은 시간 6ms(≥ 5), 홀드 뒤 3ms
    expect(r.seatIds).toEqual(['A01']);
    expect(w.calls).toEqual([]);
    expect(w.attempts.records).toHaveLength(1);
    hasNoFirstHeld(w.attempts.records[0]!);
    expect(w.warns).toEqual([]);
  });
});
