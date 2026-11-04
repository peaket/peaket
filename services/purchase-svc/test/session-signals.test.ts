// 구매 세션 종료 지표 purchase_sessions_ended_total{reason}(PromSeatSignals.sessionEnded, BUILD_ORDER PRF-138, docs/observability.md, docs/features/seat-hold.md §2 '구매 세션 종료와 정리').
// 이름표는 값이 몇 개뿐인 reason(COMPLETED·LEFT·IDLE·MAX_STAY)만 단다. 회차 ID·구매 세션 ID·계정 ID는 달지 않는다(ASVS 16.2.5, observability §8).
// test/seat-signals.test.ts(Lua 오류 지표)와 같은 방식이다.
import { fakeClock, PlatformMetrics } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  EndPurchaseSession,
  MemoryPurchaseSessionStore,
  noSeatSignals,
  PromSeatSignals,
  RecordingSessionStartedLog,
  type SeatSignals,
  SESSION_END_REASONS,
} from '../src/modules/inventory/index.js';
import { newJti, openInput } from './purchase-session-cases.js';

/** 노출 글에서 이름이 name인 표본: 이름표 글(이름=값, 이름 차례로 정렬) → 값 */
async function samplesOf(registry: PlatformMetrics['registry'], name: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const l of (await registry.metrics()).split('\n')) {
    if (!(l.startsWith(`${name}{`) || l.startsWith(`${name} `))) continue;
    const labels = [...l.matchAll(/(\w+)="([^"]*)"/g)]
      .map((m) => `${m[1]}=${m[2]}`)
      .sort()
      .join(',');
    out[labels] = Number(l.slice(l.lastIndexOf(' ') + 1));
  }
  return out;
}

const NAME = 'purchase_sessions_ended_total';

describe('PromSeatSignals.sessionEnded(purchase_sessions_ended_total)', () => {
  test('QT11_NFR015_ register 뒤 sessionEnded는 reason 이름표 하나만으로 1씩 올리고 서비스 레지스트리에 카운터로 나온다(회차·세션·계정 이름표 없음) [ASVS v5.0.0-16.2.5]', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const prom = new PromSeatSignals();
    expect(prom.register(metrics.registry)).toBe(prom);
    const s: SeatSignals = prom;
    expect(typeof s.sessionEnded).toBe('function');
    s.sessionEnded?.('LEFT');
    s.sessionEnded?.('LEFT');
    s.sessionEnded?.('IDLE');
    expect(await samplesOf(metrics.registry, NAME)).toEqual({ 'reason=LEFT': 2, 'reason=IDLE': 1 });
    const text = await metrics.registry.metrics();
    expect(text).toContain(`# TYPE ${NAME} counter`);
  });

  test('QT11_NFR015_ 네 가지 까닭(COMPLETED·LEFT·IDLE·MAX_STAY)이 각각 자기 이름표 값으로 센다', async () => {
    expect([...SESSION_END_REASONS].sort()).toEqual(['COMPLETED', 'IDLE', 'LEFT', 'MAX_STAY']);
    const metrics = new PlatformMetrics('purchase-svc');
    const s: SeatSignals = new PromSeatSignals().register(metrics.registry);
    for (const r of SESSION_END_REASONS) s.sessionEnded?.(r);
    s.sessionEnded?.('MAX_STAY');
    expect(await samplesOf(metrics.registry, NAME)).toEqual({ 'reason=COMPLETED': 1, 'reason=LEFT': 1, 'reason=IDLE': 1, 'reason=MAX_STAY': 2 });
  });

  test('QT11_NFR015_ 붙이기 전에도 sessionEnded는 던지지 않고, 두 번 만든 신호가 서로의 레지스트리를 더럽히지 않으며, Lua 오류 지표와 섞이지 않는다', async () => {
    const a: SeatSignals = new PromSeatSignals();
    expect(() => a.sessionEnded?.('COMPLETED')).not.toThrow();
    const m = new PlatformMetrics('purchase-svc');
    const b = new PromSeatSignals().register(m.registry);
    (b as SeatSignals).sessionEnded?.('LEFT');
    b.luaError('hold', 'OTHER');
    expect(await samplesOf(m.registry, NAME)).toEqual({ 'reason=LEFT': 1 });
    expect(await samplesOf(m.registry, 'seat_lua_errors_total')).toEqual({ 'code=OTHER,script=hold': 1 });
    const other = new PlatformMetrics('purchase-svc');
    new PromSeatSignals().register(other.registry);
    expect(await samplesOf(other.registry, NAME)).toEqual({});
  });

  test('QT11_ 지표를 달지 않은 조립의 기본값(noSeatSignals)은 sessionEnded를 갖지 않거나 있어도 아무 일도 하지 않는다(선택 메서드)', () => {
    const s: SeatSignals = noSeatSignals;
    expect(() => s.sessionEnded?.('LEFT')).not.toThrow();
  });

  test('QT11_NFR015_ 종단: EndPurchaseSession이 세션을 끝내면 /metrics 레지스트리에 그 까닭의 카운터가 한 번 오른다(끝낼 세션이 없었으면 오르지 않는다)', async () => {
    const clock = fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z'), monotonic: 0 });
    const metrics = new PlatformMetrics('purchase-svc');
    const prom = new PromSeatSignals().register(metrics.registry);
    const store = new MemoryPurchaseSessionStore(clock);
    const log = new RecordingSessionStartedLog();
    const uc = new EndPurchaseSession({ store, ended: log, clock, signals: prom });
    const jti = newJti();
    expect((await store.open(openInput(clock, jti, { eventId: 'ev-sig' }))).kind).toBe('CREATED');
    expect(await uc.execute({ sessionId: newJti(), reason: 'LEFT' })).toBe(false);
    expect(await samplesOf(metrics.registry, NAME)).toEqual({});
    expect(await uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(true);
    expect(await uc.execute({ sessionId: jti, reason: 'LEFT' })).toBe(false);
    expect(await samplesOf(metrics.registry, NAME)).toEqual({ 'reason=LEFT': 1 });
    // 정리 반복이 끝낸 세션의 사건도 같은 지표로 센다
    await uc.recordEnded({ eventId: 'ev-sig', sessionId: newJti(), reason: 'MAX_STAY', endedAtMs: clock.now() });
    expect(await samplesOf(metrics.registry, NAME)).toEqual({ 'reason=LEFT': 1, 'reason=MAX_STAY': 1 });
  });
});
