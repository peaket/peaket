// 구매 세션 정리 색인 s:{event:E}:sessions와 종료 사건 더하기의 계약 사례(SessionStartedLog.appendStarted의 색인 쪽·SessionIndex·SessionEndedLog, BUILD_ORDER PRF-138,
// docs/data.md §3 s:{event:E}:stream·s:{event:E}:sessions, docs/features/seat-hold.md §2 '구매 세션 종료와 정리' '정리 색인과 1초 반복',
// src/modules/inventory/adapters/purchase-session-lua.ts의 APPEND_SESSION_STARTED_LUA·APPEND_SESSION_ENDED_LUA 계약).
// 메모리(RecordingSessionStartedLog, test/session-index.test.ts)와 실제 Valkey 8.1(RedisSessionStartedLog·RedisSessionEndedLog·RedisSessionIndex,
// test-int/session-index.int.test.ts, 노드 하나짜리 클러스터 모드 포함)에 똑같이 돈다. 시각은 점검 시각(점수)을 인자로 주므로 기다리지 않는다.
import { expect, test } from 'vitest';
import {
  SESSION_IDLE_MS,
  type SessionEndedEntry,
  type SessionEndedLog,
  type SessionEndReason,
  type SessionIndex,
  type SessionStartedEntry,
  type SessionStartedLog,
  sessionCheckAt,
} from '../src/modules/inventory/index.js';
import { JOURNEY } from './purchase-session-cases.js';

/** 정리 색인·Stream 도구 */
export interface IndexHarness {
  started: SessionStartedLog;
  ended: SessionEndedLog;
  index: SessionIndex;
  /** 저장소 시계의 지금(메모리는 고정 시각, Valkey는 시험 프로세스의 시각). 시작 사건의 시각이 Stream 수명을 걸 만큼 앞이게 한다 */
  now(): number;
  /** 정리 색인 s:{event:E}:sessions의 모든 멤버(jti → 점수). 색인이 없으면 빈 Map */
  members(eventId: string): Promise<ReadonlyMap<string, number>>;
  /** 시험 전용: 색인에 멤버를 점수와 함께 직접 쓴다(ZADD) */
  seed(eventId: string, jti: string, score: number): Promise<void>;
  /** 그 회차 Stream에 더해진 SESSION_STARTED 항목(더한 차례) */
  startedItems(eventId: string): Promise<SessionStartedEntry[]>;
  /** 그 회차 Stream에 더해진 SESSION_ENDED 항목(더한 차례) */
  endedItems(eventId: string): Promise<SessionEndedEntry[]>;
}

let n = 0;
/** 시험마다 다른 회차 ID(실제 Valkey를 시험끼리 나눠 쓴다). KEY_PART 모양이다 */
export const newEvent = () => `ev-${process.pid}-${Date.now().toString(36)}-${n++}`;
let m = 0;
/** 시험마다 다른 jti. 글 순서가 만든 차례와 같다(zero-padded) */
export const newMember = (tag = 'j') => `${tag}-${process.pid}-${Date.now().toString(36)}-${String(m++).padStart(4, '0')}`;

/** 시작 사건 항목. 시작 now, 최대 체류 now + 45분(기본) */
export function startedEntry(h: { now(): number }, eventId: string, jti: string, over: Partial<SessionStartedEntry> = {}): SessionStartedEntry {
  const t = h.now();
  return { eventId, purchaseSessionId: jti, admissionJti: jti, journeyId: JOURNEY, startedAtMs: t, maxStayUntilMs: t + 45 * 60_000, ...over };
}

/** 종료 사건 항목. 끝낸 시각 now */
export function endedEntry(h: { now(): number }, eventId: string, jti: string, reason: SessionEndReason = 'LEFT', over: Partial<SessionEndedEntry> = {}): SessionEndedEntry {
  return { eventId, purchaseSessionId: jti, admissionJti: jti, reason, endedAtMs: h.now(), ...over };
}

const BAD_PARTS = ['', 'a}b', '{x}', 'a:b', 'a b', 'x'.repeat(65), 'é'];

/** (jti, 점수) 쌍으로 Map을 만든다 */
const asMap = (pairs: Array<[string, number]>) => new Map(pairs);

export function sessionIndexCases(make: () => Promise<IndexHarness> | IndexHarness): void {
  // ── appendStarted: Stream 항목과 정리 색인 ───────────────────────────────────────────────────────────────────

  test('QT11_POL009_ADR0183_11_appendStarted는 Stream 항목을 더하면서 정리 색인에 jti를 sessionCheckAt(시작, 최대 체류) 점수로 넣는다: 최대 체류가 멀면 시작 + 5분, 5분 안이면 최대 체류', async () => {
    const h = await make();
    const eventId = newEvent();
    const far = newMember();
    const near = newMember();
    const e1 = startedEntry(h, eventId, far);
    const e2 = startedEntry(h, eventId, near, { maxStayUntilMs: h.now() + 120_000 });
    await h.started.appendStarted(e1);
    await h.started.appendStarted(e2);
    expect(await h.startedItems(eventId)).toEqual([e1, e2]);
    expect(await h.members(eventId)).toEqual(
      asMap([
        [far, sessionCheckAt(e1.startedAtMs, e1.maxStayUntilMs)],
        [near, sessionCheckAt(e2.startedAtMs, e2.maxStayUntilMs)],
      ]),
    );
    expect((await h.members(eventId)).get(far)).toBe(e1.startedAtMs + SESSION_IDLE_MS);
    expect((await h.members(eventId)).get(near)).toBe(e2.maxStayUntilMs);
  });

  test('QT11_appendStarted의 색인 넣기는 NX다: 이미 있는 멤버의 점수는 바꾸지 않는다(requeue로 민 점수가 시작 사건 재시도로 되돌아가지 않는다). Stream에는 항목이 한 번 더 쌓인다', async () => {
    const h = await make();
    const eventId = newEvent();
    const jti = newMember();
    const e = startedEntry(h, eventId, jti);
    await h.started.appendStarted(e);
    const first = sessionCheckAt(e.startedAtMs, e.maxStayUntilMs);
    expect((await h.members(eventId)).get(jti)).toBe(first);

    // 점검이 살아 있는 세션을 다음 점검 시각으로 밀었다
    const later = first + 4 * 60_000;
    await h.index.requeue(eventId, jti, later);
    expect((await h.members(eventId)).get(jti)).toBe(later);

    // 시작 사건 더하기를 다시 해도(응답을 잃은 재시도) 점수는 그대로다
    await h.started.appendStarted(e);
    expect((await h.members(eventId)).get(jti)).toBe(later);
    expect(await h.startedItems(eventId)).toEqual([e, e]);

    // 더 이른 점수가 계산돼도(시작이 더 이른 항목) 있는 점수를 낮추지 않는다
    await h.started.appendStarted({ ...e, startedAtMs: e.startedAtMs - 120_000 });
    expect((await h.members(eventId)).get(jti)).toBe(later);

    // 직접 심은 점수도 그대로다
    const other = newMember();
    await h.seed(eventId, other, 123_456_789);
    await h.started.appendStarted(startedEntry(h, eventId, other));
    expect((await h.members(eventId)).get(other)).toBe(123_456_789);
  });

  test('QT11_appendStarted의 정리 색인은 회차별이다: 회차마다 따로 쌓이고 다른 회차의 멤버는 그대로다', async () => {
    const h = await make();
    const e1 = newEvent();
    const e2 = newEvent();
    const a = newMember();
    const b = newMember();
    await h.started.appendStarted(startedEntry(h, e1, a));
    await h.started.appendStarted(startedEntry(h, e2, b));
    expect([...(await h.members(e1)).keys()]).toEqual([a]);
    expect([...(await h.members(e2)).keys()]).toEqual([b]);
    expect((await h.startedItems(e1)).map((x) => x.purchaseSessionId)).toEqual([a]);
    expect((await h.startedItems(e2)).map((x) => x.purchaseSessionId)).toEqual([b]);
  });

  test('ASVS1.2.4_appendStarted의 항목 모양이 틀리면 RangeError이고 Stream도 색인도 쓰지 않는다 [ASVS v5.0.0-1.2.4]', async () => {
    const h = await make();
    const eventId = newEvent();
    const jti = newMember();
    const ok = startedEntry(h, eventId, jti);
    const bad: Array<Partial<SessionStartedEntry>> = [
      { eventId: 'a}b' },
      { purchaseSessionId: '' },
      { admissionJti: 'a:b' },
      { journeyId: 'not-a-uuid' },
      { startedAtMs: -1 },
      { startedAtMs: 1.5 },
      { maxStayUntilMs: Number.NaN },
      { maxStayUntilMs: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const over of bad) await expect(h.started.appendStarted({ ...ok, ...over }), JSON.stringify(over)).rejects.toThrow(RangeError);
    expect(await h.startedItems(eventId)).toEqual([]);
    expect((await h.members(eventId)).size).toBe(0);
  });

  // ── due ─────────────────────────────────────────────────────────────────────────────────────────────────────

  test('QT11_due는 점수가 nowMs 이하인 멤버를 점수 오름차순으로 limit개까지 준다: nowMs와 같은 점수는 들어가고 1 큰 점수는 빠진다. 같은 점수는 멤버 글 순서다', async () => {
    const h = await make();
    const eventId = newEvent();
    const [a, b, c, d, e, f] = [newMember(), newMember(), newMember(), newMember(), newMember(), newMember()] as [string, string, string, string, string, string];
    const base = 1_900_000_000_000;
    // 일부러 뒤섞어 넣는다: 점수 base+30(d), base+10(b, c: 같은 점수 → 글 순서 b, c), base+20(a), base+40(e), base+10_000(f)
    await h.seed(eventId, d, base + 30);
    await h.seed(eventId, c, base + 10);
    await h.seed(eventId, a, base + 20);
    await h.seed(eventId, e, base + 40);
    await h.seed(eventId, b, base + 10);
    await h.seed(eventId, f, base + 10_000);
    expect(await h.index.due(eventId, base + 40, 100)).toEqual([b, c, a, d, e]);
    expect(await h.index.due(eventId, base + 39, 100)).toEqual([b, c, a, d]);
    expect(await h.index.due(eventId, base + 10, 100)).toEqual([b, c]);
    expect(await h.index.due(eventId, base + 9, 100)).toEqual([]);
    expect(await h.index.due(eventId, base + 100_000, 100)).toEqual([b, c, a, d, e, f]);
    // limit은 앞에서부터 자른다
    expect(await h.index.due(eventId, base + 40, 1)).toEqual([b]);
    expect(await h.index.due(eventId, base + 40, 3)).toEqual([b, c, a]);
    expect(await h.index.due(eventId, base + 40, 5)).toEqual([b, c, a, d, e]);
    expect(await h.index.due(eventId, base + 40, 6)).toEqual([b, c, a, d, e]);
  });

  test('QT11_due는 아무것도 쓰지 않는다: 읽은 멤버가 색인에 그대로 있고 다시 불러도 같은 답이며, 없는 회차는 []이다', async () => {
    const h = await make();
    const eventId = newEvent();
    const a = newMember();
    const b = newMember();
    await h.seed(eventId, a, 1_000_000);
    await h.seed(eventId, b, 2_000_000);
    const before = await h.members(eventId);
    expect(await h.index.due(eventId, 5_000_000, 10)).toEqual([a, b]);
    expect(await h.index.due(eventId, 5_000_000, 10)).toEqual([a, b]);
    expect(await h.members(eventId)).toEqual(before);
    expect(await h.index.due(newEvent(), 5_000_000, 10)).toEqual([]);
    expect((await h.members(newEvent())).size).toBe(0);
  });

  test('QT11_due는 그 회차의 색인만 본다: 다른 회차의 멤버는 나오지 않는다', async () => {
    const h = await make();
    const e1 = newEvent();
    const e2 = newEvent();
    const a = newMember();
    const b = newMember();
    await h.seed(e1, a, 1_000_000);
    await h.seed(e2, b, 1_000_000);
    expect(await h.index.due(e1, 9_000_000, 10)).toEqual([a]);
    expect(await h.index.due(e2, 9_000_000, 10)).toEqual([b]);
  });

  test('ASVS1.2.4_due의 limit이 1 이상의 정수가 아니거나 nowMs가 0 이상의 안전한 정수가 아니거나 회차 ID가 키 조각 모양이 아니면 RangeError다 [ASVS v5.0.0-1.2.4]', async () => {
    const h = await make();
    const eventId = newEvent();
    await h.seed(eventId, newMember(), 1_000);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(h.index.due(eventId, 5_000_000, limit), `limit ${limit}`).rejects.toThrow(RangeError);
    }
    for (const now of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(h.index.due(eventId, now, 10), `nowMs ${now}`).rejects.toThrow(RangeError);
    }
    for (const bad of BAD_PARTS) await expect(h.index.due(bad, 5_000_000, 10), `eventId ${bad}`).rejects.toThrow(RangeError);
    // 틀린 호출은 색인을 바꾸지 않았다
    expect((await h.members(eventId)).size).toBe(1);
  });

  // ── requeue ─────────────────────────────────────────────────────────────────────────────────────────────────

  test('QT11_requeue는 멤버가 있을 때만 점수를 바꾼다(ZADD XX): 앞으로도 뒤로도 옮기고, 다른 멤버는 그대로다', async () => {
    const h = await make();
    const eventId = newEvent();
    const a = newMember();
    const b = newMember();
    await h.seed(eventId, a, 1_000_000);
    await h.seed(eventId, b, 2_000_000);
    await h.index.requeue(eventId, a, 3_000_000);
    expect(await h.members(eventId)).toEqual(asMap([[a, 3_000_000], [b, 2_000_000]]));
    // 점검 순서가 바뀐다
    expect(await h.index.due(eventId, 2_500_000, 10)).toEqual([b]);
    expect(await h.index.due(eventId, 3_000_000, 10)).toEqual([b, a]);
    await h.index.requeue(eventId, a, 500_000);
    expect((await h.members(eventId)).get(a)).toBe(500_000);
    expect(await h.index.due(eventId, 600_000, 10)).toEqual([a]);
    // 같은 값으로 다시 놓아도 그대로다
    await h.index.requeue(eventId, a, 500_000);
    expect((await h.members(eventId)).get(a)).toBe(500_000);
    expect((await h.members(eventId)).get(b)).toBe(2_000_000);
  });

  test('QT11_requeue는 없는 멤버를 만들지 않는다: 끝난 세션(색인에서 빠진 jti)을 되살리지 않는다. 색인이 없는 회차에도 키를 만들지 않는다', async () => {
    const h = await make();
    const eventId = newEvent();
    const a = newMember();
    const gone = newMember();
    await h.seed(eventId, a, 1_000_000);
    await h.index.requeue(eventId, gone, 7_000_000);
    expect(await h.members(eventId)).toEqual(asMap([[a, 1_000_000]]));
    expect(await h.index.due(eventId, 9_000_000, 10)).toEqual([a]);

    const empty = newEvent();
    await h.index.requeue(empty, gone, 7_000_000);
    expect((await h.members(empty)).size).toBe(0);
    expect(await h.index.due(empty, 9_000_000, 10)).toEqual([]);
    // 끝나서 빠진 멤버를 되살리지 않는다
    await h.ended.appendEnded(endedEntry(h, eventId, a));
    await h.index.requeue(eventId, a, 8_000_000);
    expect((await h.members(eventId)).size).toBe(0);
  });

  test('ASVS1.2.4_requeue의 회차 ID·jti가 키 조각 모양이 아니거나 점수가 0 이상의 안전한 정수가 아니면 RangeError이고 색인을 바꾸지 않는다 [ASVS v5.0.0-1.2.4]', async () => {
    const h = await make();
    const eventId = newEvent();
    const a = newMember();
    await h.seed(eventId, a, 1_000_000);
    for (const bad of BAD_PARTS) {
      await expect(h.index.requeue(bad, a, 5_000), `eventId ${bad}`).rejects.toThrow(RangeError);
      await expect(h.index.requeue(eventId, bad, 5_000), `jti ${bad}`).rejects.toThrow(RangeError);
    }
    for (const at of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(h.index.requeue(eventId, a, at), `atMs ${at}`).rejects.toThrow(RangeError);
    }
    expect(await h.members(eventId)).toEqual(asMap([[a, 1_000_000]]));
  });

  // ── drop ────────────────────────────────────────────────────────────────────────────────────────────────────

  test('QT11_drop은 멤버를 뺀다: 없는 멤버·없는 회차는 오류 없이 아무 일도 없고, 다른 멤버·다른 회차는 그대로다', async () => {
    const h = await make();
    const e1 = newEvent();
    const e2 = newEvent();
    const a = newMember();
    const b = newMember();
    await h.seed(e1, a, 1_000_000);
    await h.seed(e1, b, 2_000_000);
    await h.seed(e2, a, 3_000_000);
    await h.index.drop(e1, a);
    expect(await h.members(e1)).toEqual(asMap([[b, 2_000_000]]));
    expect(await h.members(e2)).toEqual(asMap([[a, 3_000_000]]));
    expect(await h.index.due(e1, 9_000_000, 10)).toEqual([b]);
    // 두 번·없는 멤버·없는 회차
    await h.index.drop(e1, a);
    await h.index.drop(e1, newMember());
    await h.index.drop(newEvent(), a);
    expect(await h.members(e1)).toEqual(asMap([[b, 2_000_000]]));
    // 마지막 멤버까지 빼면 비어 있다
    await h.index.drop(e1, b);
    expect((await h.members(e1)).size).toBe(0);
    expect(await h.index.due(e1, 9_000_000, 10)).toEqual([]);
  });

  test('ASVS1.2.4_drop의 회차 ID·jti가 키 조각 모양이 아니면 RangeError이고 색인을 바꾸지 않는다 [ASVS v5.0.0-1.2.4]', async () => {
    const h = await make();
    const eventId = newEvent();
    const a = newMember();
    await h.seed(eventId, a, 1_000_000);
    for (const bad of BAD_PARTS) {
      await expect(h.index.drop(bad, a), `eventId ${bad}`).rejects.toThrow(RangeError);
      await expect(h.index.drop(eventId, bad), `jti ${bad}`).rejects.toThrow(RangeError);
    }
    expect(await h.members(eventId)).toEqual(asMap([[a, 1_000_000]]));
  });

  // ── appendEnded ─────────────────────────────────────────────────────────────────────────────────────────────

  test('QT11_ADR0183_11_appendEnded는 SESSION_ENDED 항목을 Stream에 더하고 정리 색인에서 그 jti만 뺀다: 다른 jti는 그대로고 reason 네 값이 모두 실린다', async () => {
    const h = await make();
    const eventId = newEvent();
    const jtis = (['COMPLETED', 'LEFT', 'IDLE', 'MAX_STAY'] as const).map((reason) => ({ reason, jti: newMember() }));
    const keep = newMember();
    for (const { jti } of jtis) await h.seed(eventId, jti, 1_000_000);
    await h.seed(eventId, keep, 2_000_000);

    const entries: SessionEndedEntry[] = [];
    for (const { reason, jti } of jtis) {
      const e = endedEntry(h, eventId, jti, reason);
      entries.push(e);
      await h.ended.appendEnded(e);
      expect((await h.members(eventId)).has(jti), `${reason} 뺌`).toBe(false);
    }
    expect(await h.endedItems(eventId)).toEqual(entries);
    expect(await h.members(eventId)).toEqual(asMap([[keep, 2_000_000]]));
    expect(await h.index.due(eventId, 9_000_000, 10)).toEqual([keep]);
  });

  test('QT11_appendEnded: 색인에 없는 jti도 항목은 더해지고(오류 없음) 색인은 그대로다. 색인이 없는 회차에도 색인 키를 만들지 않는다', async () => {
    const h = await make();
    const eventId = newEvent();
    const a = newMember();
    const stray = newMember();
    await h.seed(eventId, a, 1_000_000);
    const e = endedEntry(h, eventId, stray, 'IDLE');
    await h.ended.appendEnded(e);
    expect(await h.endedItems(eventId)).toEqual([e]);
    expect(await h.members(eventId)).toEqual(asMap([[a, 1_000_000]]));

    const bare = newEvent();
    const e2 = endedEntry(h, bare, stray, 'LEFT');
    await h.ended.appendEnded(e2);
    expect(await h.endedItems(bare)).toEqual([e2]);
    expect((await h.members(bare)).size).toBe(0);
  });

  test('QT11_appendEnded는 회차별이다: 한 회차의 종료는 다른 회차의 같은 jti 색인 멤버와 Stream을 건드리지 않는다', async () => {
    const h = await make();
    const e1 = newEvent();
    const e2 = newEvent();
    const jti = newMember();
    await h.seed(e1, jti, 1_000_000);
    await h.seed(e2, jti, 1_000_000);
    await h.ended.appendEnded(endedEntry(h, e1, jti, 'LEFT'));
    expect((await h.members(e1)).size).toBe(0);
    expect(await h.members(e2)).toEqual(asMap([[jti, 1_000_000]]));
    expect(await h.endedItems(e2)).toEqual([]);
    expect(await h.endedItems(e1)).toHaveLength(1);
  });

  test('QT11_종료 항목과 시작 항목은 같은 회차 Stream에 종류별로 쌓인다: 시작 사건을 더한 세션을 끝내면 색인에서 빠지고 시작 항목은 그대로 남는다', async () => {
    const h = await make();
    const eventId = newEvent();
    const jti = newMember();
    const s = startedEntry(h, eventId, jti);
    await h.started.appendStarted(s);
    expect((await h.members(eventId)).has(jti)).toBe(true);
    const e = endedEntry(h, eventId, jti, 'COMPLETED');
    await h.ended.appendEnded(e);
    expect((await h.members(eventId)).has(jti)).toBe(false);
    expect(await h.startedItems(eventId)).toEqual([s]);
    expect(await h.endedItems(eventId)).toEqual([e]);
  });

  test('ASVS1.2.4_appendEnded의 항목 모양이 틀리면 RangeError이고 Stream도 색인도 바꾸지 않는다 [ASVS v5.0.0-1.2.4]', async () => {
    const h = await make();
    const eventId = newEvent();
    const jti = newMember();
    await h.seed(eventId, jti, 1_000_000);
    const ok = endedEntry(h, eventId, jti, 'IDLE');
    const bad: Array<Partial<SessionEndedEntry>> = [
      { eventId: 'a}b' },
      { purchaseSessionId: '' },
      { admissionJti: 'a:b' },
      { reason: 'UNRECOGNIZED' as SessionEndReason },
      { reason: 'idle' as SessionEndReason },
      { reason: undefined as unknown as SessionEndReason },
      { endedAtMs: -1 },
      { endedAtMs: 1.5 },
      { endedAtMs: Number.NaN },
      { endedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const over of bad) await expect(h.ended.appendEnded({ ...ok, ...over }), JSON.stringify(over)).rejects.toThrow(RangeError);
    expect(await h.endedItems(eventId)).toEqual([]);
    expect(await h.members(eventId)).toEqual(asMap([[jti, 1_000_000]]));
  });
}
