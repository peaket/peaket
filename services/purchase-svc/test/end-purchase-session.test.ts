// 구매 세션 끝내기 유스케이스(EndPurchaseSession, BUILD_ORDER PRF-138, docs/features/seat-hold.md §2 '구매 세션 종료와 정리', 상태 기계 docs/planning/03 §2.2 T9·T11,
// Q-T11(자리 즉시 비움), S-T33 ⑥(LEFT 뒤 같은 대기표 재입장), [ASVS v5.0.0-16.2.5]). 나가기(LEFT)와 결제 확정(COMPLETED)이 부르고, 정리 반복은 recordEnded로 IDLE·MAX_STAY의 사건을 더한다.
// 차례: 세션 상태 지우기(store.end) → SESSION_ENDED 더하기(실패해도 끝난 것은 그대로, 로그 한 줄) → 지표.
// 저장소는 메모리 구현(MemoryPurchaseSessionStore·RecordingSessionStartedLog), 시각은 주입한 가짜 시계다(고정 sleep 없음).
import { inspect } from 'node:util';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  EndPurchaseSession,
  type EndPurchaseSessionDeps,
  EndSessionError,
  MemoryPurchaseSessionStore,
  type PurchaseSessionStore,
  RecordingSessionStartedLog,
  type SeatSignals,
  SeatStoreUnavailable,
  SESSION_IDLE_MS,
  type SessionEndReason,
} from '../src/modules/inventory/index.js';
import { newJti, openInput } from './purchase-session-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const EVENT_A = 'ev-end-a';
const EVENT_B = 'ev-end-b';

interface WarnCall {
  obj: unknown;
  msg: string;
}

/**
 * 메모리 조립 하나. 저장소는 호출을 적고 fail로 실패를 끼운다. 사건·색인은 RecordingSessionStartedLog 하나가 맡는다.
 * 정리 색인은 시작 사건 기록(appendStarted)에 기대지 않고 시험이 직접 채운다(점수 = 열린 시각 + 유휴 5분)
 */
function world(o: { signals?: boolean; logger?: boolean; onEnded?: EndPurchaseSessionDeps['onEnded'] } = {}) {
  const clock = fakeClock({ now: NOW, monotonic: 0 });
  const inner = new MemoryPurchaseSessionStore(clock);
  const log = new RecordingSessionStartedLog();
  const calls = { end: [] as string[], read: [] as string[] };
  const fail: { end?: unknown; read?: unknown } = {};
  const store: Pick<PurchaseSessionStore, 'end' | 'read'> = {
    end: async (jti, opt) => {
      calls.end.push(jti);
      if (fail.end !== undefined) throw fail.end;
      return inner.end(jti, opt);
    },
    read: async (jti) => {
      calls.read.push(jti);
      if (fail.read !== undefined) throw fail.read;
      return inner.read(jti);
    },
  };
  const metrics: SessionEndReason[] = [];
  const signals: Pick<SeatSignals, 'sessionEnded'> = { sessionEnded: (reason) => void metrics.push(reason) };
  const warns: WarnCall[] = [];
  const logger = { warn: (obj: object, msg: string) => void warns.push({ obj, msg }) };
  const uc = new EndPurchaseSession({ store, ended: log, clock, ...(o.signals === false ? {} : { signals }), ...(o.logger === false ? {} : { logger }), ...(o.onEnded ? { onEnded: o.onEnded } : {}) });

  /** 구매 세션을 열고 정리 색인에 넣는다 */
  async function open(eventId = EVENT_A, jti = newJti()): Promise<string> {
    const r = await inner.open(openInput(clock, jti, { eventId }));
    expect(r.kind).toBe('CREATED');
    const m = log.index.get(eventId) ?? new Map<string, number>();
    m.set(jti, clock.now() + SESSION_IDLE_MS);
    log.index.set(eventId, m);
    return jti;
  }
  const inIndex = (eventId: string, jti: string) => log.index.get(eventId)?.has(jti) ?? false;
  return { clock, inner, log, calls, fail, metrics, warns, uc, open, inIndex };
}

/** 로그 한 줄의 모든 글(숨은 칸까지): 새면 안 되는 값을 찾는다 */
const everything = (w: WarnCall) => `${inspect(w.obj, { depth: 10, showHidden: true })}\n${w.msg}`;

describe('EndPurchaseSession.execute: 끝내기', () => {
  test.each(['LEFT', 'COMPLETED'] as const)(
    'QT11_ST33_%s로 끝내면 true이고 세션 상태가 지워지며 SESSION_ENDED 한 건(회차·구매 세션 ID·입장 토큰 jti·까닭·끝낸 시각)을 더하고 정리 색인에서 그 세션만 뺀다',
    async (reason) => {
      const w = await world();
      const jti = await w.open(EVENT_A);
      const other = await w.open(EVENT_A);
      const elsewhere = await w.open(EVENT_B);
      w.clock.advance(1234);
      expect(await w.uc.execute({ sessionId: jti, reason })).toBe(true);
      expect(await w.inner.read(jti)).toBeUndefined();
      expect(w.log.endedEntries).toEqual([{ eventId: EVENT_A, purchaseSessionId: jti, admissionJti: jti, reason, endedAtMs: NOW + 1234 }]);
      expect(w.inIndex(EVENT_A, jti)).toBe(false);
      // 다른 세션(같은 회차·다른 회차)은 그대로다
      expect(await w.inner.read(other)).toMatchObject({ sessionId: other, eventId: EVENT_A });
      expect(await w.inner.read(elsewhere)).toMatchObject({ sessionId: elsewhere, eventId: EVENT_B });
      expect(w.inIndex(EVENT_A, other)).toBe(true);
      expect(w.inIndex(EVENT_B, elsewhere)).toBe(true);
    },
  );

  test('QT11_ST33_끝낸 세션은 세션 상태만 지워진다: 같은 입장 토큰으로 다시 열면 ENDED이고 세션이 되살아나지 않는다(LEFT 뒤 같은 대기표로 새 구매 세션을 못 연다)', async () => {
    const w = await world();
    const jti = await w.open(EVENT_A);
    expect(await w.uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(true);
    expect(await w.inner.open(openInput(w.clock, jti, { eventId: EVENT_A }))).toEqual({ kind: 'ENDED' });
    expect(await w.inner.read(jti)).toBeUndefined();
  });

  test('QT11_이미 없는 세션을 끝내면 false이고 사건도 지표도 더하지 않는다', async () => {
    const w = await world();
    expect(await w.uc.execute({ sessionId: newJti(), reason: 'LEFT' })).toBe(false);
    expect(w.log.endedEntries).toEqual([]);
    expect(w.metrics).toEqual([]);
    expect(w.warns).toEqual([]);
  });

  test('QT11_ST33_같은 세션을 두 번 끝내면 첫 번째만 true이고 SESSION_ENDED도 지표도 하나다(두 번 불러도 한 번만 끝난다)', async () => {
    const w = await world();
    const jti = await w.open();
    expect(await w.uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(true);
    expect(await w.uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(false);
    // 나가기와 결제 확정이 겹쳐도 먼저 끝낸 쪽 하나만 남는다
    expect(await w.uc.execute({ sessionId: jti, reason: 'COMPLETED' })).toBe(false);
    expect(w.log.endedEntries).toHaveLength(1);
    expect(w.log.endedEntries[0]).toMatchObject({ purchaseSessionId: jti, reason: 'LEFT' });
    expect(w.metrics).toEqual(['LEFT']);
  });

  test('QT11_ST33_동시에 같은 세션을 끝내려는 두 호출 가운데 하나만 true이고 사건은 하나다', async () => {
    const w = await world();
    const jti = await w.open();
    const rs = await Promise.all([w.uc.execute({ sessionId: jti, reason: 'LEFT' }), w.uc.execute({ sessionId: jti, reason: 'COMPLETED' })]);
    expect(rs.filter(Boolean)).toHaveLength(1);
    expect(w.log.endedEntries).toHaveLength(1);
    expect(w.metrics).toHaveLength(1);
  });
});

describe('EndPurchaseSession.execute: 회차 확인(expectEventId, 받는 층이 403으로 바꾼다)', () => {
  test('QT11_세션의 회차가 기대한 회차와 다르면 EndSessionError(EVENT_MISMATCH)로 거절하고 세션·정리 색인은 그대로이며 사건도 지표도 없다 [ASVS v5.0.0-8.2.2]', async () => {
    const w = await world();
    const jti = await w.open(EVENT_A);
    const p = w.uc.execute({ sessionId: jti, reason: 'LEFT', expectEventId: EVENT_B });
    await expect(p).rejects.toBeInstanceOf(EndSessionError);
    await expect(w.uc.execute({ sessionId: jti, reason: 'LEFT', expectEventId: EVENT_B })).rejects.toMatchObject({ code: 'EVENT_MISMATCH', name: 'EndSessionError' });
    expect(await w.inner.read(jti)).toMatchObject({ sessionId: jti, eventId: EVENT_A });
    expect(w.calls.end).toEqual([]);
    expect(w.inIndex(EVENT_A, jti)).toBe(true);
    expect(w.log.endedEntries).toEqual([]);
    expect(w.metrics).toEqual([]);
  });

  test('QT11_기대한 회차가 세션의 회차와 같으면 끝낸다(true). 거절 뒤에도 같은 세션을 맞는 회차로 끝낼 수 있다 [ASVS v5.0.0-8.2.2]', async () => {
    const w = await world();
    const jti = await w.open(EVENT_A);
    await expect(w.uc.execute({ sessionId: jti, reason: 'LEFT', expectEventId: EVENT_B })).rejects.toBeInstanceOf(EndSessionError);
    expect(await w.uc.execute({ sessionId: jti, reason: 'LEFT', expectEventId: EVENT_A })).toBe(true);
    expect(await w.inner.read(jti)).toBeUndefined();
    expect(w.log.endedEntries).toEqual([expect.objectContaining({ eventId: EVENT_A, purchaseSessionId: jti, reason: 'LEFT' })]);
    expect(w.metrics).toEqual(['LEFT']);
  });

  test('QT11_expectEventId가 있어도 세션이 없으면 던지지 않고 false이며 사건도 지표도 없다', async () => {
    const w = await world();
    expect(await w.uc.execute({ sessionId: newJti(), reason: 'LEFT', expectEventId: EVENT_A })).toBe(false);
    expect(w.log.endedEntries).toEqual([]);
    expect(w.metrics).toEqual([]);
  });

  test('QT11_expectEventId 없이 끝낼 때는 세션을 따로 읽지 않는다(결제 확정은 회차를 대조하지 않는다)', async () => {
    const w = await world();
    const jti = await w.open();
    expect(await w.uc.execute({ sessionId: jti, reason: 'COMPLETED' })).toBe(true);
    expect(w.calls.read).toEqual([]);
    expect(w.calls.end).toEqual([jti]);
  });
});

describe('EndPurchaseSession.execute: 사건 더하기가 실패해도 끝낸 것은 그대로', () => {
  test.each([
    ['unavailable', undefined],
    ['oom', 'oom'],
  ] as const)(
    'QT11_ST33_SESSION_ENDED 더하기가 좌석 Redis 장애(%s)로 실패해도 던지지 않고 true이며 세션은 이미 끝났다. warn 한 줄에는 오류 이름만 있고 세션 ID·키 이름·오류 글은 없고 지표는 한 번이다 [ASVS v5.0.0-16.2.5]',
    async (_what, reason) => {
      const w = await world();
      const jti = await w.open(EVENT_A);
      w.log.failEndedWith = new SeatStoreUnavailable(new Error(`connection lost s:{event:${EVENT_A}}:sessions ${jti}`), reason);
      expect(await w.uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(true);
      expect(await w.inner.read(jti)).toBeUndefined();
      expect(w.log.endedEntries).toEqual([]);
      // 사건이 빠져도 정리 색인에는 그 jti가 남아, 다음 정리 점검이 GONE으로 빼며 흔적을 지운다(Q-T11: 종료 사건이 사라져도 정리된다)
      expect(w.inIndex(EVENT_A, jti)).toBe(true);
      expect(w.warns).toHaveLength(1);
      const text = everything(w.warns[0]!);
      expect(text).toContain('SeatStoreUnavailable');
      expect(text).not.toContain(jti);
      expect(text).not.toContain('s:{');
      expect(text).not.toContain(':sessions');
      expect(text).not.toContain('connection lost');
      expect(text).not.toContain('좌석 Redis를 잠시');
      expect(w.metrics).toEqual(['LEFT']);
    },
  );

  test('QT11_ST33_로거와 지표를 달지 않은 조립도 더하기 실패를 던지지 않는다', async () => {
    const w = await world({ signals: false, logger: false });
    const jti = await w.open();
    w.log.failEndedWith = new SeatStoreUnavailable(new Error('down'));
    expect(await w.uc.execute({ sessionId: jti, reason: 'COMPLETED' })).toBe(true);
    expect(await w.inner.read(jti)).toBeUndefined();
  });

  test('QT11_더하기가 실패한 세션은 이미 없으므로 다시 끝내면 false이고 사건을 더하지 않는다(입장 자리는 최대 체류 시각에 정리된다)', async () => {
    const w = await world();
    const jti = await w.open();
    w.log.failEndedWith = new SeatStoreUnavailable(new Error('down'));
    expect(await w.uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(true);
    w.log.failEndedWith = undefined;
    expect(await w.uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(false);
    expect(w.log.endedEntries).toEqual([]);
  });
});

describe('EndPurchaseSession.execute: 세션 상태 지우기(store.end)의 실패', () => {
  test.each([
    ['unavailable', undefined],
    ['oom', 'oom'],
  ] as const)('QT11_ST33_store.end가 좌석 Redis 장애(%s)면 그 오류를 그대로 던지고 사건도 지표도 더하지 않는다. 장애가 풀리면 같은 세션을 끝낼 수 있다', async (_what, reason) => {
    const w = await world();
    const jti = await w.open(EVENT_A);
    const err = new SeatStoreUnavailable(new Error('down'), reason);
    w.fail.end = err;
    await expect(w.uc.execute({ sessionId: jti, reason: 'LEFT' })).rejects.toBe(err);
    expect(w.log.endedEntries).toEqual([]);
    expect(w.metrics).toEqual([]);
    expect(w.inIndex(EVENT_A, jti)).toBe(true);
    w.fail.end = undefined;
    expect(await w.uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(true);
    expect(w.log.endedEntries).toHaveLength(1);
    expect(w.metrics).toEqual(['LEFT']);
  });

  test('QT11_expectEventId를 대조하려고 읽은 store.read가 장애면 그 오류를 그대로 던지고 세션을 끝내지 않는다', async () => {
    const w = await world();
    const jti = await w.open(EVENT_A);
    const err = new SeatStoreUnavailable(new Error('down'));
    w.fail.read = err;
    await expect(w.uc.execute({ sessionId: jti, reason: 'LEFT', expectEventId: EVENT_A })).rejects.toBe(err);
    expect(w.calls.end).toEqual([]);
    expect(w.log.endedEntries).toEqual([]);
    expect(w.metrics).toEqual([]);
    w.fail.read = undefined;
    expect(await w.inner.read(jti)).toBeDefined();
  });
});

describe('EndPurchaseSession.execute: 지표 purchase_sessions_ended_total{reason}', () => {
  test('QT11_지표 sessionEnded(reason)는 끝낼 때마다 그 까닭으로 한 번이고, 끝낼 세션이 없었으면 0번이다', async () => {
    const w = await world();
    const a = await w.open();
    const b = await w.open();
    expect(await w.uc.execute({ sessionId: newJti(), reason: 'LEFT' })).toBe(false);
    expect(w.metrics).toEqual([]);
    expect(await w.uc.execute({ sessionId: a, reason: 'LEFT' })).toBe(true);
    expect(w.metrics).toEqual(['LEFT']);
    expect(await w.uc.execute({ sessionId: b, reason: 'COMPLETED' })).toBe(true);
    expect(w.metrics).toEqual(['LEFT', 'COMPLETED']);
    expect(await w.uc.execute({ sessionId: a, reason: 'LEFT' })).toBe(false);
    expect(w.metrics).toEqual(['LEFT', 'COMPLETED']);
  });
});

describe('EndPurchaseSession.execute: 입력 모양', () => {
  test.each(['', 'a b', 'a}b', 'a:b', 'x'.repeat(65), 'a\nb'])('QT11_sessionId %j 가 키 조각 모양이 아니면 RangeError이고 저장소·사건·지표를 건드리지 않는다 [ASVS v5.0.0-2.1.1]', async (bad) => {
    const w = await world();
    const jti = await w.open();
    await expect(w.uc.execute({ sessionId: bad, reason: 'LEFT' })).rejects.toBeInstanceOf(RangeError);
    await expect(w.uc.execute({ sessionId: bad, reason: 'LEFT', expectEventId: EVENT_A })).rejects.toBeInstanceOf(RangeError);
    expect(w.calls.end).toEqual([]);
    expect(w.log.endedEntries).toEqual([]);
    expect(w.metrics).toEqual([]);
    expect(await w.inner.read(jti)).toBeDefined();
  });
});

describe('EndPurchaseSession.recordEnded: 정리 반복이 끝낸 세션의 사건', () => {
  test.each(['IDLE', 'MAX_STAY'] as const)('QT11_POL009_%s로 끝낸 세션은 SESSION_ENDED 한 건을 더하고 정리 색인에서 빼며 지표를 한 번 올린다(끝낸 시각은 넘긴 값 그대로)', async (reason) => {
    const w = await world();
    const jti = await w.open(EVENT_A);
    const other = await w.open(EVENT_A);
    // 세션 상태는 점검 Lua가 이미 지웠다
    w.inner.endSession(jti);
    await w.uc.recordEnded({ eventId: EVENT_A, sessionId: jti, reason, endedAtMs: NOW + 777 });
    expect(w.log.endedEntries).toEqual([{ eventId: EVENT_A, purchaseSessionId: jti, admissionJti: jti, reason, endedAtMs: NOW + 777 }]);
    expect(w.inIndex(EVENT_A, jti)).toBe(false);
    expect(w.inIndex(EVENT_A, other)).toBe(true);
    expect(w.metrics).toEqual([reason]);
    expect(w.warns).toEqual([]);
  });

  test('QT11_recordEnded는 사건 더하기가 실패해도 던지지 않고 warn 한 줄(오류 이름만)을 남기며 지표는 한 번이다 [ASVS v5.0.0-16.2.5]', async () => {
    const w = await world();
    const jti = await w.open(EVENT_A);
    w.log.failEndedWith = new SeatStoreUnavailable(new Error(`down s:{event:${EVENT_A}}:stream ${jti}`));
    await expect(w.uc.recordEnded({ eventId: EVENT_A, sessionId: jti, reason: 'IDLE', endedAtMs: NOW })).resolves.toBeUndefined();
    expect(w.log.endedEntries).toEqual([]);
    expect(w.warns).toHaveLength(1);
    const text = everything(w.warns[0]!);
    expect(text).toContain('SeatStoreUnavailable');
    expect(text).not.toContain(jti);
    expect(text).not.toContain('s:{');
    expect(text).not.toContain('down');
    expect(w.metrics).toEqual(['IDLE']);
  });
});

describe('EndPurchaseSession 주문 만료 고리 onEnded(BUILD_ORDER PRF-172, ADR-0107, docs/features/seat-hold.md §2)', () => {
  /** 고리가 받은 값들. 부를 때의 세션 끝내기 호출 수도 적는다('끝낸 뒤'에 부르는지 본다) */
  function hooked(onCall?: () => void) {
    const seen: { purchaseSessionId: string; endCalls: number }[] = [];
    const w = world({
      onEnded: (e) => {
        seen.push({ purchaseSessionId: e.purchaseSessionId, endCalls: w.calls.end.length });
        onCall?.();
      },
    });
    return { w, seen };
  }

  test.each(['LEFT', 'COMPLETED'] as const)('PT41_ADR0107_%s로 끝내면 세션을 끝낸 뒤 고리를 그 구매 세션 ID로 한 번 부른다 [ASVS v5.0.0-2.3.1]', async (reason) => {
    const { w, seen } = hooked();
    const jti = await w.open();
    expect(await w.uc.execute({ sessionId: jti, reason })).toBe(true);
    expect(seen).toEqual([{ purchaseSessionId: jti, endCalls: 1 }]);
  });

  test.each(['IDLE', 'MAX_STAY'] as const)('PT41_ADR0107_정리 반복이 %s로 끝낸 세션도 recordEnded가 고리를 한 번 부른다 [ASVS v5.0.0-2.3.1]', async (reason) => {
    const { w, seen } = hooked();
    const jti = await w.open();
    w.inner.endSession(jti);
    await w.uc.recordEnded({ eventId: EVENT_A, sessionId: jti, reason, endedAtMs: NOW });
    expect(seen.map((s) => s.purchaseSessionId)).toEqual([jti]);
  });

  test('ADR0107_끝낼 세션이 없었거나 이미 끝났으면 고리를 부르지 않는다', async () => {
    const { w, seen } = hooked();
    expect(await w.uc.execute({ sessionId: newJti(), reason: 'LEFT' })).toBe(false);
    expect(seen).toEqual([]);
    const jti = await w.open();
    expect(await w.uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(true);
    expect(await w.uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(false);
    expect(seen).toHaveLength(1);
  });

  test('ADR0107_회차가 달라 거절했거나 세션 지우기가 실패하면 끝낸 것이 아니므로 고리를 부르지 않는다', async () => {
    const { w, seen } = hooked();
    const jti = await w.open(EVENT_A);
    await expect(w.uc.execute({ sessionId: jti, reason: 'LEFT', expectEventId: EVENT_B })).rejects.toBeInstanceOf(EndSessionError);
    w.fail.end = new SeatStoreUnavailable(new Error('down'));
    await expect(w.uc.execute({ sessionId: jti, reason: 'LEFT' })).rejects.toBeInstanceOf(SeatStoreUnavailable);
    expect(seen).toEqual([]);
  });

  test('ADR0107_종료 사건 더하기가 실패해도 세션은 끝났으므로 고리를 부른다 [ASVS v5.0.0-16.5.2]', async () => {
    const { w, seen } = hooked();
    const jti = await w.open();
    w.log.failEndedWith = new SeatStoreUnavailable(new Error('down'));
    expect(await w.uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(true);
    expect(seen.map((s) => s.purchaseSessionId)).toEqual([jti]);
  });

  test('ADR0107_고리가 던져도 execute의 결과는 그대로이고 사건·지표도 그대로다 [ASVS v5.0.0-16.5.2]', async () => {
    const { w, seen } = hooked(() => {
      throw new Error('hook down');
    });
    const jti = await w.open();
    await expect(w.uc.execute({ sessionId: jti, reason: 'LEFT' })).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(await w.inner.read(jti)).toBeUndefined();
    expect(w.log.endedEntries).toHaveLength(1);
    expect(w.metrics).toEqual(['LEFT']);
  });

  test('ADR0107_고리가 던져도 recordEnded는 던지지 않고 사건·지표는 그대로다 [ASVS v5.0.0-16.5.2]', async () => {
    const { w, seen } = hooked(() => {
      throw new Error('hook down');
    });
    const jti = await w.open();
    w.inner.endSession(jti);
    await expect(w.uc.recordEnded({ eventId: EVENT_A, sessionId: jti, reason: 'IDLE', endedAtMs: NOW })).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(w.log.endedEntries).toHaveLength(1);
    expect(w.metrics).toEqual(['IDLE']);
  });
});
