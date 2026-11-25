// F-02-5(OPS-300) purchase-svc 사전 모의 센 값: 명령 3 키 넷을 읽기 전용 PreviewControl로 준다
// (ADR-0365 결정 11 표: purchaseSessions = 정리 색인 s:{event:E}:sessions 멤버 수, paymentSessions = 그 가운데 Paying 표시 pay가 있는 세션 수,
// holdsPerSecond5m·paymentAcceptsPerSecond5m = 최근 5분 홀드 성공·결제 접수 수 ÷ 300(저장소 기록에서 센다, 원천이 없으면 no-source),
// 결정 16 꼴·'아무것도 쓰지 않는다', 계획 14절 1 'paymentSessions는 10,000개 [가정] 넘으면 too-many').
// 계획 docs/review/plans/F-02-5.md 8.3의 이름 그대로: PurchaseSessionCounter·SaleRecordCounter·PreviewCounts({ sessions, records, clock }).run({ eventId, keys }),
// PURCHASE_PREVIEW_KEYS·PAYING_COUNT_MAX·PREVIEW_WINDOW_MS, 제어 서버 ControlDeps.preview·previewControl(req, deps).
// 두 포트는 Redis·DB 어댑터 자리의 짝 가짜(implements)다. 기록 셈 짝 가짜는 '기록 시각 > sinceMs'만 세어(5분 정각에 찍힌 기록은 창 밖) 진짜 SQL과 같은 뜻을 지킨다.
// 진짜 어댑터의 셈은 test-int/f025-preview-counts.int.test.ts가 실제 Valkey·PostgreSQL로 본다.
// 시험 이름: C-T6 ①, 장부 밖 세부는 F025-PREVIEW(B21·B22).
import { randomUUID } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { previewControl, type ControlDeps } from '../src/control/control-server.js';
import { PAYING_COUNT_MAX, PREVIEW_WINDOW_MS, PURCHASE_PREVIEW_KEYS, PreviewCounts, type PurchaseSessionCounter, type SaleRecordCounter } from '../src/modules/inventory/index.js';
import { MemorySaleControlCopies, MemorySaleControlStore, SetSaleSuspension } from '../src/modules/sale-control/index.js';

/** 정본 명령 3 키 가운데 purchase-svc 몫 넷(ADR-0365 결정 11 표) */
const CANON_KEYS = ['purchaseSessions', 'paymentSessions', 'holdsPerSecond5m', 'paymentAcceptsPerSecond5m'];
/** 정본 5분(ADR-0365 결정 11 '최근 5분') */
const FIVE_MIN_MS = 5 * 60_000;
/** 정본 나눗수 300(초) */
const PER_SECOND_DIVISOR = 300;
const NOW = Date.parse('2026-12-05T11:02:30.250Z');
const INVALID_ARGUMENT = 3;
const UNIMPLEMENTED = 12;

/** 세션 셈 짝 가짜. 회차마다 정한 답을 주고 불린 회차를 남긴다 */
class FixedSessionCounter implements PurchaseSessionCounter {
  readonly asked: string[] = [];
  constructor(private readonly answers: ReadonlyMap<string, { sessions: number; paying: number } | 'too-many'>) {}
  async count(eventId: string): Promise<{ sessions: number; paying: number } | 'too-many'> {
    this.asked.push(eventId);
    return this.answers.get(eventId) ?? { sessions: 0, paying: 0 };
  }
}

/** 기록 셈 짝 가짜: 회차마다 홀드·접수 기록 시각을 두고 sinceMs보다 늦은 것만 센다. 원천이 없는 칸은 undefined */
class TimedRecordCounter implements SaleRecordCounter {
  readonly asked: { eventId: string; sinceMs: number }[] = [];
  constructor(private readonly records: ReadonlyMap<string, { holds?: readonly number[]; accepts?: readonly number[] }>) {}
  async count(eventId: string, sinceMs: number): Promise<{ holds?: number; accepts?: number }> {
    this.asked.push({ eventId, sinceMs });
    const r = this.records.get(eventId) ?? { holds: [], accepts: [] };
    const within = (xs: readonly number[]) => xs.filter((at) => at > sinceMs).length;
    return { ...(r.holds ? { holds: within(r.holds) } : {}), ...(r.accepts ? { accepts: within(r.accepts) } : {}) };
  }
}

function world(o: { sessions?: Map<string, { sessions: number; paying: number } | 'too-many'>; records?: Map<string, { holds?: readonly number[]; accepts?: readonly number[] }> } = {}) {
  const clock = fakeClock({ now: NOW });
  const sessions = new FixedSessionCounter(o.sessions ?? new Map());
  const records = new TimedRecordCounter(o.records ?? new Map());
  const preview = new PreviewCounts({ sessions, records, clock });
  return { clock, sessions, records, preview };
}

const sorted = <T extends { key: string }>(xs: readonly T[]) => [...xs].sort((a, b) => a.key.localeCompare(b.key));
/** n개의 기록 시각을 [from, to] 안에 고르게 찍는다 */
const spread = (n: number, from: number, to: number) => Array.from({ length: n }, (_, i) => from + Math.floor(((to - from) * i) / Math.max(1, n - 1)));

describe('F025-PREVIEW purchase-svc 키 목록과 상수 (B20)', () => {
  test('F025-PREVIEW ① PURCHASE_PREVIEW_KEYS는 정본 명령 3 키 가운데 purchase-svc 몫 넷이고, 창은 5분·Paying 셈 상한은 10,000이다', () => {
    expect([...PURCHASE_PREVIEW_KEYS].sort()).toEqual([...CANON_KEYS].sort());
    expect(PREVIEW_WINDOW_MS).toBe(FIVE_MIN_MS);
    // 계획 14절 1의 [가정] 값
    expect(PAYING_COUNT_MAX).toBe(10_000);
  });
});

describe('C-T6 ① purchase-svc PreviewCounts 센 값 (B20)', () => {
  test('C-T6 ① purchaseSessions는 색인 멤버 수, paymentSessions는 Paying 세션 수이고 measuredAtMs는 센 시각이다', async () => {
    const e = randomUUID();
    const w = world({ sessions: new Map([[e, { sessions: 2_731, paying: 418 }]]) });
    const r = await w.preview.run({ eventId: e, keys: ['purchaseSessions', 'paymentSessions'] });
    expect(r.unavailable).toEqual([]);
    expect(sorted(r.counts).map((c) => [c.key, c.value, c.measuredAtMs])).toEqual([
      ['paymentSessions', 418, NOW],
      ['purchaseSessions', 2_731, NOW],
    ]);
    for (const c of r.counts) expect(c.source).toMatch(/^[a-z][a-z0-9:_-]*$/);
    expect(w.sessions.asked).toEqual([e]);
  });

  test('C-T6 ① 초당 홀드·접수는 최근 5분 기록 수 ÷ 300이고, 셈 창의 시작은 센 시각 − 5분이다', async () => {
    const e = randomUUID();
    const w = world({ records: new Map([[e, { holds: spread(1_234, NOW - FIVE_MIN_MS + 1, NOW), accepts: spread(77, NOW - FIVE_MIN_MS + 1, NOW) }]]) });
    const r = await w.preview.run({ eventId: e, keys: ['holdsPerSecond5m', 'paymentAcceptsPerSecond5m'] });
    expect(r.unavailable).toEqual([]);
    const byKey = Object.fromEntries(r.counts.map((c) => [c.key, c]));
    expect(byKey.holdsPerSecond5m).toMatchObject({ value: 1_234 / PER_SECOND_DIVISOR, measuredAtMs: NOW });
    expect(byKey.paymentAcceptsPerSecond5m).toMatchObject({ value: 77 / PER_SECOND_DIVISOR, measuredAtMs: NOW });
    expect(w.records.asked).toEqual([{ eventId: e, sinceMs: NOW - FIVE_MIN_MS }]);
  });

  test('C-T6 ① 5분 경계: 센 시각 − 5분 + 1ms의 기록은 세고, 정확히 5분 전의 기록은 세지 않는다', async () => {
    const e = randomUUID();
    const w = world({ records: new Map([[e, { holds: [NOW - FIVE_MIN_MS, NOW - FIVE_MIN_MS + 1, NOW - FIVE_MIN_MS - 1], accepts: [NOW - FIVE_MIN_MS] }]]) });
    const r = await w.preview.run({ eventId: e, keys: ['holdsPerSecond5m', 'paymentAcceptsPerSecond5m'] });
    const byKey = Object.fromEntries(r.counts.map((c) => [c.key, c.value]));
    expect(byKey).toEqual({ holdsPerSecond5m: 1 / PER_SECOND_DIVISOR, paymentAcceptsPerSecond5m: 0 });
  });

  test('C-T6 ① 센 시각은 부른 때의 시계다(시계를 옮기면 창도 함께 옮긴다)', async () => {
    const e = randomUUID();
    const w = world({ records: new Map([[e, { holds: [NOW - 60_000], accepts: [] }]]) });
    w.clock.advance(FIVE_MIN_MS - 60_000);
    const r = await w.preview.run({ eventId: e, keys: ['holdsPerSecond5m'] });
    expect(r.counts).toMatchObject([{ key: 'holdsPerSecond5m', value: 0, measuredAtMs: NOW + FIVE_MIN_MS - 60_000 }]);
    expect(w.records.asked).toEqual([{ eventId: e, sinceMs: NOW - 60_000 }]);
  });
});

describe('F025-PREVIEW purchase-svc 세지 못함은 0이 아니라 unavailable (B21)', () => {
  test('F025-PREVIEW ② 세션 셈이 too-many면 두 세션 키는 too-many이고 0을 적지 않는다(기록 키는 그대로 센다)', async () => {
    const e = randomUUID();
    const w = world({ sessions: new Map([[e, 'too-many']]), records: new Map([[e, { holds: [NOW - 1], accepts: [] }]]) });
    const r = await w.preview.run({ eventId: e, keys: [...CANON_KEYS] });
    expect(sorted(r.unavailable)).toEqual([
      { key: 'paymentSessions', reason: 'too-many' },
      { key: 'purchaseSessions', reason: 'too-many' },
    ]);
    expect(sorted(r.counts).map((c) => [c.key, c.value])).toEqual([
      ['holdsPerSecond5m', 1 / PER_SECOND_DIVISOR],
      ['paymentAcceptsPerSecond5m', 0],
    ]);
  });

  test('F025-PREVIEW ③ 기록 원천이 없는 칸(undefined)은 그 키만 no-source다', async () => {
    const e = randomUUID();
    const w = world({ records: new Map([[e, { holds: [NOW - 10, NOW - 20] }]]) });
    const r = await w.preview.run({ eventId: e, keys: ['holdsPerSecond5m', 'paymentAcceptsPerSecond5m'] });
    expect(r.counts.map((c) => [c.key, c.value])).toEqual([['holdsPerSecond5m', 2 / PER_SECOND_DIVISOR]]);
    expect(r.unavailable).toEqual([{ key: 'paymentAcceptsPerSecond5m', reason: 'no-source' }]);
  });

  test('F025-PREVIEW ④ purchase-svc가 세지 않는 키(waiting은 queue-svc 몫, 명령 1 키)와 모르는 글은 unknown-key다', async () => {
    const e = randomUUID();
    const w = world({ sessions: new Map([[e, { sessions: 3, paying: 1 }]]) });
    const r = await w.preview.run({ eventId: e, keys: ['waiting', 'currentTarget', 'purchaseSessions', 'nope'] });
    expect(r.counts.map((c) => [c.key, c.value])).toEqual([['purchaseSessions', 3]]);
    expect(sorted(r.unavailable)).toEqual([
      { key: 'currentTarget', reason: 'unknown-key' },
      { key: 'nope', reason: 'unknown-key' },
      { key: 'waiting', reason: 'unknown-key' },
    ]);
  });

  test('F025-PREVIEW ⑤ 묻지 않은 원천은 부르지 않는다(세션 키만 물으면 기록 셈을, 기록 키만 물으면 세션 셈을 부르지 않는다)', async () => {
    const e = randomUUID();
    const a = world({ sessions: new Map([[e, { sessions: 9, paying: 2 }]]) });
    await a.preview.run({ eventId: e, keys: ['paymentSessions'] });
    expect(a.records.asked).toEqual([]);
    const b = world({ records: new Map([[e, { holds: [], accepts: [] }]]) });
    await b.preview.run({ eventId: e, keys: ['holdsPerSecond5m'] });
    expect(b.sessions.asked).toEqual([]);
  });
});

describe('F025-PREVIEW purchase-svc 제어 포트 PreviewControl 꼴 (B22)', () => {
  const deps = (preview: PreviewCounts | undefined) => {
    const store = new MemorySaleControlStore();
    const copies = new MemorySaleControlCopies();
    const d: ControlDeps = { setSuspension: new SetSaleSuspension(store, copies), podName: 'purchase-svc-3', nowMs: () => NOW, ...(preview ? { preview } : {}) };
    return { store, copies, deps: d };
  };

  test('F025-PREVIEW ⑥ 센 값·파드 이름을 주고 판매 제어 저장소·사본에는 아무것도 쓰지 않는다', async () => {
    const e = randomUUID();
    const w = world({ sessions: new Map([[e, { sessions: 12, paying: 5 }]]) });
    const d = deps(w.preview);
    const r = await previewControl({ scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', keys: ['purchaseSessions', 'paymentSessions', 'waiting'] }, d.deps);
    expect(r.podName).toBe('purchase-svc-3');
    expect(sorted(r.counts).map((c) => [c.key, c.value])).toEqual([
      ['paymentSessions', 5],
      ['purchaseSessions', 12],
    ]);
    expect(r.unavailable).toEqual([{ key: 'waiting', reason: 'unknown-key' }]);
    expect(d.store.rows.size).toBe(0);
    expect(d.copies.written.size).toBe(0);
  });

  test('F025-PREVIEW ⑦ 범위가 소문자 UUID가 아니면(대문자·PLATFORM·빈 글) INVALID_ARGUMENT이고 원천을 부르지 않는다', async () => {
    const w = world();
    const d = deps(w.preview);
    for (const scope of [randomUUID().toUpperCase(), 'PLATFORM', '', 'e-1']) {
      await expect(previewControl({ scope, kind: 'CONTROL_KIND_SALE_PAUSE', keys: ['purchaseSessions'] }, d.deps), `scope=${scope}`).rejects.toMatchObject({ code: INVALID_ARGUMENT });
    }
    expect(w.sessions.asked).toEqual([]);
  });

  test('F025-PREVIEW ⑧ keys 0개·17개는 INVALID_ARGUMENT, 16개(상한 정각)는 받는다', async () => {
    const e = randomUUID();
    const w = world({ sessions: new Map([[e, { sessions: 1, paying: 0 }]]) });
    const d = deps(w.preview);
    await expect(previewControl({ scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', keys: [] }, d.deps)).rejects.toMatchObject({ code: INVALID_ARGUMENT });
    const sixteen = [...CANON_KEYS, ...Array.from({ length: 12 }, (_, i) => `x${i}`)];
    const ok = await previewControl({ scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', keys: sixteen }, d.deps);
    expect(ok.counts.length + ok.unavailable.length).toBe(16);
    await expect(previewControl({ scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', keys: [...sixteen, 'x99'] }, d.deps)).rejects.toMatchObject({ code: INVALID_ARGUMENT });
  });

  test('F025-PREVIEW ⑨ CONTROL_KIND_SALE_PAUSE가 아닌 종류와 사전 모의를 조립하지 않은 파드는 UNIMPLEMENTED다', async () => {
    const e = randomUUID();
    const w = world();
    for (const kind of ['CONTROL_KIND_SALE_SUSPENSION', 'CONTROL_KIND_ADMISSION_TARGET', '']) {
      await expect(previewControl({ scope: e, kind, keys: ['purchaseSessions'] }, deps(w.preview).deps), `kind=${kind}`).rejects.toMatchObject({ code: UNIMPLEMENTED });
    }
    await expect(previewControl({ scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', keys: ['purchaseSessions'] }, deps(undefined).deps)).rejects.toMatchObject({ code: UNIMPLEMENTED });
  });
});
