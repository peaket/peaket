// 좌석 Redis Stream 릴레이(SeatStreamRelay, BUILD_ORDER PRF-141, docs/features/seat-hold.md §6 '홀드 원장 적재의 첫 구현'의 '읽는 법'·'보내는 법'·'보낼 수 없는 항목',
// docs/data.md §4 '홀드 원장 적재와 Stream 릴레이', docs/observability.md seat_stream_relay_*). Stream 읽기·Kafka 보내기·코덱·지표·로그는 시험 안의 메모리 대역이고,
// 쉬기는 deps.sleep을 바꿔 끼워 손으로 푼다(고정 sleep 없음). 대역 source는 확인(ack)받지 못한 항목을 다음 read에 다시 돌려준다(XREADGROUP … 0과 같다).
import { describe, expect, test } from 'vitest';
import {
  PURCHASE_SESSION_TOPIC,
  SEAT_TOPIC,
  STREAM_RELAY_BACKOFF_MAX_MS,
  STREAM_RELAY_BACKOFF_MIN_MS,
  STREAM_RELAY_BATCH,
  STREAM_RELAY_MAX_BATCHES,
  STREAM_RELAY_TICK_MS,
  SeatStreamRelay,
  type SeatStreamEntry,
  type SeatStreamRelayDeps,
  type SeatStreamSource,
  type StreamDropReason,
  type TradeEventCodec,
  type TradeEventPublisher,
  type TradeRecord,
  type TradeTopic,
  routeStreamEntry,
  sessionEndedFields,
  sessionStartedFields,
} from '../src/modules/inventory/index.js';

const EV_A = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const EV_B = '0190f3a1-7c2e-7a00-8000-0000000000e2';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000acc01';
const HOLD = '019a4b2c-1d00-7e00-8a00-00000000b01d';
const PSID = 'jti-abc-1';
const JNY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const AT = Date.parse('2026-11-04T03:00:00.123Z');

const seatOf = (n: number) => `0190f3a1-7c2e-7a00-8000-00000000a${String(n).padStart(3, '0')}`;

/** 홀드 Lua·만료 Lua가 XADD하는 칸(값은 모두 글) */
function holdFields(type: 'HELD' | 'RELEASED' | 'EXPIRED', seat: number, over: Record<string, string> = {}): Record<string, string> {
  return {
    type,
    seatIdx: String(seat),
    seatId: seatOf(seat),
    tierId: 'tier-r',
    sectionId: 'sec-a',
    holdId: HOLD,
    holdKind: 'FAN',
    purchaseSessionId: PSID,
    accountId: ACCOUNT,
    fencingToken: '1762225200123456',
    sectionVersion: '42',
    seatEpoch: '1762225000',
    occurredAtMs: String(AT),
    expiresAtMs: String(AT + 7 * 60_000),
    ...over,
  };
}
const held = (id: string, seat: number, over: Record<string, string> = {}): SeatStreamEntry => ({ id, fields: holdFields('HELD', seat, over) });
const released = (id: string, seat: number): SeatStreamEntry => ({ id, fields: holdFields('RELEASED', seat) });
const expired = (id: string, seat: number, over: Record<string, string> = {}): SeatStreamEntry => ({ id, fields: holdFields('EXPIRED', seat, over) });
const flat = (xs: string[]) => Object.fromEntries(Array.from({ length: xs.length / 2 }, (_, i) => [xs[2 * i]!, xs[2 * i + 1]!]));
const started = (id: string): SeatStreamEntry => ({
  id,
  fields: flat(sessionStartedFields({ eventId: EV_A, purchaseSessionId: PSID, admissionJti: PSID, journeyId: JNY, startedAtMs: AT - 60_000, maxStayUntilMs: AT + 44 * 60_000 })),
});
const ended = (id: string): SeatStreamEntry => ({ id, fields: flat(sessionEndedFields({ eventId: EV_A, purchaseSessionId: PSID, admissionJti: PSID, reason: 'LEFT', endedAtMs: AT + 60_000 })) });
/** 좌석맵 판에 없는 좌석의 EXPIRED(만료 Lua가 좌석 칸을 빈 글로 쓴다) */
const unmapped = (id: string, seat: number): SeatStreamEntry => expired(id, seat, { seatId: '', tierId: '', sectionId: '', sectionVersion: '' });

/** 대역 코덱의 값: 토픽과 메시지를 함께 적은 바이트(어떤 메시지로 encode를 불렀는지 값만 보고 알 수 있다) */
const encoded = (topic: TradeTopic, message: object) => Buffer.from(JSON.stringify({ topic, message }), 'utf8');

/** 항목의 (토픽, 메시지): 도메인 갈 곳 함수 그대로(보낼 수 있는 항목만) */
function sendOf(eventId: string, e: SeatStreamEntry): [TradeTopic, object] {
  const r = routeStreamEntry(eventId, e);
  if (r.kind !== 'send') throw new Error(`시험 준비 오류: ${e.id}는 보낼 수 있는 항목이 아니다`);
  return [r.topic, r.message];
}
/** 그 항목이 만들어야 할 레코드(headers는 {} 이상) */
function recordOf(eventId: string, e: SeatStreamEntry) {
  const [topic, message] = sendOf(eventId, e);
  return { topic, key: eventId, value: encoded(topic, message), headers: expect.any(Object) as Record<string, string> };
}

/** 미뤄 둔 약속 */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}
/** 지금 쌓인 약속 작업을 한 바퀴 돌린다(시간을 기다리지 않는다) */
const flush = () => new Promise<void>((r) => setImmediate(r));
/** 조건이 설 때까지 쌓인 작업을 한 바퀴씩 돌린다(400바퀴까지) */
async function settle(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await flush();
}

type Stage = 'read' | 'publish' | 'ack';

/** 메모리 조립 하나. 대역은 호출을 적고, fail로 갈래마다 실패를, wait로 잠시 붙잡기를 끼운다 */
function world(streams: Record<string, SeatStreamEntry[]> = {}) {
  const pending = new Map<string, SeatStreamEntry[]>(Object.entries(streams).map(([e, xs]) => [e, [...xs]]));
  /** 틱('tick' = 회차 목록 읽기)과 쉬기(ms)의 차례 */
  const log: Array<'tick' | number> = [];
  const calls = { events: 0, read: [] as [string, number][], ack: [] as [string, string[]][], publish: [] as TradeRecord[][], encode: [] as [TradeTopic, object][] };
  const fail: { events?: () => unknown; read?: (eventId: string) => unknown; ack?: (eventId: string) => unknown; publish?: (records: TradeRecord[]) => unknown } = {};
  const wait: { events?: () => Promise<void>; publish?: () => Promise<void> } = {};
  const hooks: { onEvents?: (n: number) => void } = {};
  const source: SeatStreamSource = {
    events: async () => {
      calls.events += 1;
      log.push('tick');
      hooks.onEvents?.(calls.events);
      await wait.events?.();
      const x = fail.events?.();
      if (x !== undefined) throw x;
      return [...pending.keys()];
    },
    read: async (eventId, count) => {
      calls.read.push([eventId, count]);
      const x = fail.read?.(eventId);
      if (x !== undefined) throw x;
      return (pending.get(eventId) ?? []).slice(0, count).map((e) => ({ id: e.id, fields: { ...e.fields } }));
    },
    ack: async (eventId, ids) => {
      calls.ack.push([eventId, [...ids]]);
      const x = fail.ack?.(eventId);
      if (x !== undefined) throw x;
      pending.set(
        eventId,
        (pending.get(eventId) ?? []).filter((e) => !ids.includes(e.id)),
      );
    },
  };
  const publisher: TradeEventPublisher = {
    publish: async (records) => {
      calls.publish.push(records.map((r) => ({ ...r })));
      await wait.publish?.();
      const x = fail.publish?.(records);
      if (x !== undefined) throw x;
    },
  };
  const codec: TradeEventCodec = {
    encode: (topic, message) => {
      calls.encode.push([topic, message]);
      return encoded(topic, message);
    },
  };
  const sent: [TradeTopic, number][] = [];
  const dropped: StreamDropReason[] = [];
  const failed: Stage[] = [];
  const signals = {
    sent: (t: TradeTopic, n: number) => void sent.push([t, n]),
    dropped: (r: StreamDropReason) => void dropped.push(r),
    failed: (s: Stage) => void failed.push(s),
  };
  const lines: { obj: object; msg: string }[] = [];
  const logger = { warn: (obj: object, msg: string) => void lines.push({ obj, msg }) };
  /** 손으로 푸는 쉬기. signal이 끊으면 바로 풀린다(던지지 않는다, platform outbox-relay의 쉬기와 같다) */
  const sleeps: { ms: number; signal: AbortSignal; done: boolean; release: () => void }[] = [];
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      log.push(ms);
      const s = {
        ms,
        signal,
        done: false,
        release: () => {
          if (s.done) return;
          s.done = true;
          resolve();
        },
      };
      sleeps.push(s);
      if (signal?.aborted) s.release();
      else signal?.addEventListener('abort', () => s.release(), { once: true });
    });
  const relay = (over: Partial<SeatStreamRelayDeps> = {}) => new SeatStreamRelay({ source, publisher, codec, signals, logger, sleep, ...over });
  const sentBy = (topic: TradeTopic) => sent.filter(([t]) => t === topic).reduce((a, [, n]) => a + n, 0);
  const pendingSleeps = () => sleeps.filter((s) => !s.done);
  const add = (eventId: string, e: SeatStreamEntry) => void pending.set(eventId, [...(pending.get(eventId) ?? []), e]);
  const logText = () => lines.map((l) => `${JSON.stringify(l.obj)} ${l.msg}`).join('\n');
  return { pending, log, calls, fail, wait, hooks, source, publisher, codec, signals, sent, dropped, failed, lines, logger, sleeps, sleep, relay, sentBy, pendingSleeps, add, logText };
}

/** 회차 하나의 결과에서 실패가 없고 보낸·넘긴·확인한 수가 모두 0인지(읽은 것이 없는 회차) */
const idle = (r: { sent: number; dropped: number; acked: number; failed?: Stage } | undefined) => r === undefined || (r.sent === 0 && r.dropped === 0 && r.acked === 0 && r.failed === undefined);

describe('SeatStreamRelay.tick: 읽은 묶음을 차례대로 보내고 확인받은 것만 지운다', () => {
  test('ST5_회차마다 read(회차, 100)한 묶음을 Stream ID 순 그대로 레코드로 만들어 publish 한 번에 보낸다: topic은 갈 곳, key는 회차 ID, value는 codec.encode(topic, message) [S-T5]', async () => {
    const entries = [held('1762225200000-0', 1), started('1762225200000-1'), expired('1762225200001-0', 2), released('1762225200002-0', 3), ended('1762225200002-1')];
    const w = world({ [EV_A]: entries });
    const t = await w.relay().tick();
    expect(STREAM_RELAY_BATCH).toBe(100);
    expect(w.calls.read).toEqual([[EV_A, STREAM_RELAY_BATCH]]);
    expect(w.calls.publish).toHaveLength(1);
    expect(w.calls.publish[0]).toEqual(entries.map((e) => recordOf(EV_A, e)));
    expect(w.calls.publish[0]!.map((r) => r.topic)).toEqual([SEAT_TOPIC, PURCHASE_SESSION_TOPIC, SEAT_TOPIC, SEAT_TOPIC, PURCHASE_SESSION_TOPIC]);
    expect(w.calls.encode).toEqual(entries.map((e) => sendOf(EV_A, e)));
    for (const r of w.calls.publish[0]!) {
      expect(r.headers).not.toBeNull();
      expect(typeof r.headers).toBe('object');
      for (const v of Object.values(r.headers)) expect(typeof v).toBe('string');
    }
    expect(t).toEqual({ events: [{ eventId: EV_A, sent: 5, dropped: 0, acked: 5 }] });
  });

  test('publish가 끝나기(Kafka 확인) 전에는 ack하지 않고 sent 지표도 올리지 않는다. 끝난 뒤 그 묶음의 모든 ID를 Stream ID 순으로 ack하고 topic별 수만큼 sent를 올린다 [ASVS v5.0.0-16.5.2]', async () => {
    const entries = [held('1762225200000-0', 1), started('1762225200000-1'), held('1762225200001-0', 2), ended('1762225200001-1')];
    const w = world({ [EV_A]: entries });
    const gate = deferred();
    w.wait.publish = () => gate.promise;
    const p = w.relay().tick();
    p.catch(() => undefined);
    await settle(() => w.calls.publish.length === 1);
    for (let i = 0; i < 10; i++) await flush();
    expect(w.calls.publish).toHaveLength(1);
    expect(w.calls.ack).toEqual([]);
    expect(w.sent).toEqual([]);
    gate.resolve();
    await p;
    expect(w.calls.ack).toEqual([[EV_A, entries.map((e) => e.id)]]);
    expect(w.sentBy(SEAT_TOPIC)).toBe(2);
    expect(w.sentBy(PURCHASE_SESSION_TOPIC)).toBe(2);
    expect(w.pending.get(EV_A)).toEqual([]);
  });

  test('보낼 수 없는 항목(좌석맵 판에 없는 좌석·모르는 type·모양 틀림)은 레코드에 없고 dropped(reason)이 오르며, 확인은 넘긴 항목까지 묶음의 모든 ID를 Stream ID 순으로 한다 [ASVS v5.0.0-16.5.2]', async () => {
    const ok1 = held('1762225200000-0', 1);
    const um = unmapped('1762225200000-1', 9);
    const unknown: SeatStreamEntry = { id: '1762225200001-0', fields: { ...holdFields('HELD', 4), type: 'BOGUS' } };
    const bad = held('1762225200002-0', 5, { fencingToken: 'not-a-number' });
    const ok2 = started('1762225200002-1');
    const w = world({ [EV_A]: [ok1, um, unknown, bad, ok2] });
    const t = await w.relay().tick();
    expect(w.calls.publish).toEqual([[recordOf(EV_A, ok1), recordOf(EV_A, ok2)]]);
    expect(w.calls.ack).toEqual([[EV_A, [ok1.id, um.id, unknown.id, bad.id, ok2.id]]]);
    expect(w.dropped).toEqual(['unmapped_seat', 'unknown_type', 'malformed']);
    expect(w.sentBy(SEAT_TOPIC)).toBe(1);
    expect(w.sentBy(PURCHASE_SESSION_TOPIC)).toBe(1);
    expect(t).toEqual({ events: [{ eventId: EV_A, sent: 2, dropped: 3, acked: 5 }] });
    expect(w.pending.get(EV_A)).toEqual([]);
  });

  test('넘긴 항목은 경고 로그에 항목 ID와 type만 남기고 값 칸(계정·구매 세션·홀드·좌석 ID)은 싣지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const secret = (n: number) => ({
      accountId: `acct-secret-${n}`,
      purchaseSessionId: `psid-secret-${n}`,
      holdId: `hold-secret-${n}`,
    });
    const um = expired('1762225200000-1', 9, { ...secret(1), seatId: '', tierId: '', sectionId: '', sectionVersion: '' });
    const unknown: SeatStreamEntry = { id: '1762225200001-0', fields: { ...holdFields('HELD', 4, secret(2)), seatId: 'seat-secret-2', type: 'BOGUS' } };
    const bad = held('1762225200002-0', 5, { ...secret(3), seatId: 'seat-secret-3', fencingToken: 'x' });
    const w = world({ [EV_A]: [held('1762225200000-0', 1), um, unknown, bad] });
    await w.relay().tick();
    expect(w.lines.length).toBeGreaterThanOrEqual(1);
    const text = w.logText();
    for (const [e, type] of [
      [um, 'EXPIRED'],
      [unknown, 'BOGUS'],
      [bad, 'HELD'],
    ] as const) {
      expect(text, e.id).toContain(e.id);
      expect(text, type).toContain(type);
    }
    for (const s of ['acct-secret', 'psid-secret', 'hold-secret', 'seat-secret', ACCOUNT, PSID, HOLD]) expect(text, s).not.toContain(s);
  });

  test('묶음이 모두 넘길 항목이면 publish를 부르지 않고(빈 publish 없음) 넘긴 ID를 ack한다', async () => {
    const um = unmapped('1762225200000-0', 9);
    const unknown: SeatStreamEntry = { id: '1762225200000-1', fields: { type: 'NOPE' } };
    const w = world({ [EV_A]: [um, unknown] });
    const t = await w.relay().tick();
    expect(w.calls.publish).toEqual([]);
    expect(w.calls.encode).toEqual([]);
    expect(w.calls.ack).toEqual([[EV_A, [um.id, unknown.id]]]);
    expect(w.dropped).toEqual(['unmapped_seat', 'unknown_type']);
    expect(w.sent.filter(([, n]) => n !== 0)).toEqual([]);
    expect(t).toEqual({ events: [{ eventId: EV_A, sent: 0, dropped: 2, acked: 2 }] });
  });

  test('읽은 것이 없으면 publish·ack·encode 아무것도 부르지 않는다', async () => {
    const w = world({ [EV_A]: [] });
    const t = await w.relay().tick();
    expect(w.calls.read).toEqual([[EV_A, STREAM_RELAY_BATCH]]);
    expect(w.calls.publish).toEqual([]);
    expect(w.calls.ack).toEqual([]);
    expect(w.calls.encode).toEqual([]);
    expect(w.failed).toEqual([]);
    expect(idle(t.events.find((e) => e.eventId === EV_A))).toBe(true);
  });

  test('회차가 여럿이면 회차마다 자기 묶음을 따로 publish하고(key는 그 회차) 따로 ack한다', async () => {
    const a = [held('1762225200000-0', 1), held('1762225200000-1', 2)];
    const b = [expired('1762225200003-0', 7)];
    const w = world({ [EV_A]: a, [EV_B]: b });
    const t = await w.relay().tick();
    expect(w.calls.publish).toHaveLength(2);
    const byKey = new Map(w.calls.publish.map((rs) => [rs[0]!.key, rs]));
    expect(w.calls.publish.every((rs) => rs.every((r) => r.key === rs[0]!.key))).toBe(true);
    expect(byKey.get(EV_A)).toEqual(a.map((e) => recordOf(EV_A, e)));
    expect(byKey.get(EV_B)).toEqual(b.map((e) => recordOf(EV_B, e)));
    expect([...w.calls.ack].sort((x, y) => x[0].localeCompare(y[0]))).toEqual([
      [EV_A, a.map((e) => e.id)],
      [EV_B, b.map((e) => e.id)],
    ]);
    expect([...t.events].sort((x, y) => x.eventId.localeCompare(y.eventId))).toEqual([
      { eventId: EV_A, sent: 2, dropped: 0, acked: 2 },
      { eventId: EV_B, sent: 1, dropped: 0, acked: 1 },
    ]);
  });

  test('deps.batch로 한 번에 읽는 수를 바꾼다: 3개를 2개·1개 묶음으로 나눠 차례대로 보내고 묶음마다 확인한다(묶음이 꽉 차면 한 틱 안에서 이어 읽는다)', async () => {
    const entries = [held('1762225200000-0', 1), held('1762225200000-1', 2), held('1762225200001-0', 3)];
    const w = world({ [EV_A]: entries });
    const r = w.relay({ batch: 2 });
    expect((await r.tick()).events).toEqual([{ eventId: EV_A, sent: 3, dropped: 0, acked: 3 }]);
    expect(w.calls.read).toEqual([
      [EV_A, 2],
      [EV_A, 2],
    ]);
    expect(w.calls.publish[0]).toEqual(entries.slice(0, 2).map((e) => recordOf(EV_A, e)));
    expect(w.calls.publish[1]).toEqual([recordOf(EV_A, entries[2]!)]);
    expect(w.calls.ack).toEqual([
      [EV_A, entries.slice(0, 2).map((e) => e.id)],
      [EV_A, [entries[2]!.id]],
    ]);
    expect((await r.tick()).events).toEqual([{ eventId: EV_A, sent: 0, dropped: 0, acked: 0 }]);
  });

  test('지표·로그를 넘기지 않아도(선택 deps) 넘길 항목이 섞인 묶음을 보내고 확인한다', async () => {
    const w = world({ [EV_A]: [held('1762225200000-0', 1), unmapped('1762225200000-1', 9)] });
    const r = new SeatStreamRelay({ source: w.source, publisher: w.publisher, codec: w.codec, sleep: w.sleep });
    expect((await r.tick()).events).toEqual([{ eventId: EV_A, sent: 1, dropped: 1, acked: 2 }]);
    expect(w.calls.ack).toEqual([[EV_A, ['1762225200000-0', '1762225200000-1']]]);
  });
});

describe('SeatStreamRelay.tick: 실패', () => {
  test('publish가 던지면 ack하지 않고 failed(publish)이며, 다음 틱에 같은 항목을 다시 읽어 같은 레코드로 보낸 뒤에야 ack한다(적어도 한 번) [ASVS v5.0.0-16.5.2]', async () => {
    const entries = [held('1762225200000-0', 1), started('1762225200000-1')];
    const w = world({ [EV_A]: entries });
    const r = w.relay();
    w.fail.publish = () => new Error('kafka down');
    const t1 = await r.tick();
    expect(t1.events).toHaveLength(1);
    expect(t1.events[0]).toMatchObject({ eventId: EV_A, sent: 0, acked: 0, failed: 'publish' });
    expect(w.calls.ack).toEqual([]);
    expect(w.failed).toEqual(['publish']);
    expect(w.sent.filter(([, n]) => n !== 0)).toEqual([]);
    expect(w.pending.get(EV_A)).toHaveLength(2);
    w.fail.publish = undefined;
    const t2 = await r.tick();
    expect(w.calls.read).toEqual([
      [EV_A, STREAM_RELAY_BATCH],
      [EV_A, STREAM_RELAY_BATCH],
    ]);
    expect(w.calls.publish).toHaveLength(2);
    expect(w.calls.publish[1]).toEqual(w.calls.publish[0]);
    expect(w.calls.publish[1]).toEqual(entries.map((e) => recordOf(EV_A, e)));
    expect(w.calls.ack).toEqual([[EV_A, entries.map((e) => e.id)]]);
    expect(t2.events).toEqual([{ eventId: EV_A, sent: 2, dropped: 0, acked: 2 }]);
    expect(w.failed).toEqual(['publish']);
    expect(w.sentBy(SEAT_TOPIC)).toBe(1);
    expect(w.sentBy(PURCHASE_SESSION_TOPIC)).toBe(1);
  });

  test('read 실패는 failed(read)이고 그 회차만 건너뛴다: 다른 회차는 보내고 확인한다 [ASVS v5.0.0-16.5.2]', async () => {
    const b = [held('1762225200005-0', 3)];
    const w = world({ [EV_A]: [held('1762225200000-0', 1)], [EV_B]: b });
    w.fail.read = (e) => (e === EV_A ? new Error('redis down') : undefined);
    const t = await w.relay().tick();
    const byId = Object.fromEntries(t.events.map((e) => [e.eventId, e]));
    expect(byId[EV_A]).toEqual({ eventId: EV_A, sent: 0, dropped: 0, acked: 0, failed: 'read' });
    expect(byId[EV_B]).toEqual({ eventId: EV_B, sent: 1, dropped: 0, acked: 1 });
    expect(w.calls.publish).toEqual([b.map((e) => recordOf(EV_B, e))]);
    expect(w.calls.ack).toEqual([[EV_B, [b[0]!.id]]]);
    expect(w.failed).toEqual(['read']);
    expect(w.pending.get(EV_A)).toHaveLength(1);
  });

  test('한 회차의 publish 실패는 다른 회차의 보내기·확인을 막지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world({ [EV_A]: [held('1762225200000-0', 1)], [EV_B]: [held('1762225200005-0', 3)] });
    w.fail.publish = (records) => (records.some((r) => r.key === EV_A) ? new Error('kafka down') : undefined);
    const t = await w.relay().tick();
    const byId = Object.fromEntries(t.events.map((e) => [e.eventId, e]));
    expect(byId[EV_A]).toMatchObject({ eventId: EV_A, sent: 0, acked: 0, failed: 'publish' });
    expect(byId[EV_B]).toEqual({ eventId: EV_B, sent: 1, dropped: 0, acked: 1 });
    expect(w.calls.ack).toEqual([[EV_B, ['1762225200005-0']]]);
    expect(w.pending.get(EV_A)).toHaveLength(1);
    expect(w.pending.get(EV_B)).toEqual([]);
  });

  test('ack가 던지면 failed(ack)이고 acked 0이다. 확인되지 않은 항목은 다음 틱에 다시 읽어 다시 보낸다 [ASVS v5.0.0-16.5.2]', async () => {
    const entries = [held('1762225200000-0', 1)];
    const w = world({ [EV_A]: entries });
    const r = w.relay();
    w.fail.ack = () => new Error('redis down');
    const t1 = await r.tick();
    expect(t1.events[0]).toMatchObject({ eventId: EV_A, acked: 0, failed: 'ack' });
    expect(w.failed).toEqual(['ack']);
    expect(w.pending.get(EV_A)).toHaveLength(1);
    // sent 지표는 'Kafka 확인을 받아 지운 항목 수'라 지우지 못한 틱에는 오르지 않는다(시험 검토 B가 찾음)
    expect(w.sent.filter(([, n]) => n !== 0)).toEqual([]);
    w.fail.ack = undefined;
    const t2 = await r.tick();
    expect(w.sentBy(SEAT_TOPIC), '다시 보내 지운 뒤에 한 번만 센다').toBe(1);
    expect(w.calls.publish).toHaveLength(2);
    expect(w.calls.publish[1]).toEqual(entries.map((e) => recordOf(EV_A, e)));
    expect(t2.events).toEqual([{ eventId: EV_A, sent: 1, dropped: 0, acked: 1 }]);
    expect(w.pending.get(EV_A)).toEqual([]);
  });

  test('회차 목록 읽기가 실패해도 던지지 않고 빈 결과이며 아무 회차도 읽지 않는다', async () => {
    const w = world({ [EV_A]: [held('1762225200000-0', 1)] });
    w.fail.events = () => new Error('redis down');
    await expect(w.relay().tick()).resolves.toEqual({ events: [] });
    expect(w.calls.read).toEqual([]);
    expect(w.calls.publish).toEqual([]);
    expect(w.calls.ack).toEqual([]);
  });
});

/** start 뒤 조건이 설 때까지 돌린다. 그사이 걸린 쉬기는 하나씩 풀어 준다(첫 틱 전에 쉬는 구현도 받는다) */
async function runUntil(w: ReturnType<typeof world>, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) {
    await settle(() => ok() || w.pendingSleeps().length > 0);
    if (ok()) return;
    w.pendingSleeps()[0]?.release();
  }
}

describe('SeatStreamRelay.start·stop', () => {
  test('start를 두 번 불러도 반복은 하나다(돌던 틱이 끝나지 않은 동안 두 번째 틱이 시작되지 않는다)', async () => {
    const w = world({ [EV_A]: [held('1762225200000-0', 1)] });
    const gate = deferred();
    w.wait.events = () => gate.promise;
    const r = w.relay();
    r.start();
    r.start();
    await runUntil(w, () => w.calls.events >= 1);
    // 첫 틱 전에 쉬는 구현이면 두 번째 반복의 쉬기도 풀어 본다
    for (let i = 0; i < 5; i++) {
      for (const s of w.pendingSleeps()) s.release();
      await flush();
    }
    expect(w.calls.events).toBe(1);
    gate.resolve();
    await r.stop();
  });

  test('stop은 돌던 묶음(보내기·확인)이 끝날 때까지 기다리고, 그 뒤로 틱이 없다. 회차 목록을 읽는 중에 멈추면 묶음을 읽지 않고 끝난다(PRF-164 리뷰 고침 M2: 멈춤 신호를 회차 사이·묶음 사이마다 본다) [ASVS v5.0.0-16.5.2]', async () => {
    const w = world({ [EV_A]: [held('1762225200000-0', 1)] });
    const gate = deferred();
    w.wait.publish = () => gate.promise;
    const r = w.relay();
    r.start();
    await runUntil(w, () => w.calls.publish.length >= 1);
    let stopped = false;
    const p = r.stop().then(() => void (stopped = true));
    for (let i = 0; i < 10; i++) await flush();
    expect(stopped).toBe(false);
    gate.resolve();
    await p;
    expect(stopped).toBe(true);
    expect(w.calls.ack).toEqual([[EV_A, ['1762225200000-0']]]);
    for (let i = 0; i < 20; i++) {
      for (const s of w.pendingSleeps()) s.release();
      await flush();
    }
    expect(w.calls.events).toBe(1);

    // 회차 목록을 읽는 중에 멈춤: 목록 읽기는 기다리고, 묶음은 읽지 않는다(남은 항목은 다음 리더가 보낸다)
    const v = world({ [EV_A]: [held('1762225200000-0', 1)] });
    const listGate = deferred();
    v.wait.events = () => listGate.promise;
    const rv = v.relay();
    rv.start();
    await runUntil(v, () => v.calls.events >= 1);
    let vStopped = false;
    const pv = rv.stop().then(() => void (vStopped = true));
    for (let i = 0; i < 10; i++) await flush();
    expect(vStopped).toBe(false);
    listGate.resolve();
    await pv;
    expect(v.calls.read).toEqual([]);
    expect(v.calls.ack).toEqual([]);
    expect(v.pending.get(EV_A)).toHaveLength(1);
  });

  test('stop은 쉬는 중이면 쉬기를 끊고(signal을 끊는다) 바로 끝난다. 그 뒤로 틱이 없다', async () => {
    const w = world({ [EV_A]: [] });
    const r = w.relay();
    r.start();
    await runUntil(w, () => w.calls.events >= 1 && w.pendingSleeps().length >= 1);
    expect(w.pendingSleeps().length).toBeGreaterThanOrEqual(1);
    const ticks = w.calls.events;
    await r.stop();
    expect(w.sleeps.every((s) => s.done)).toBe(true);
    expect(w.sleeps.at(-1)!.signal.aborted).toBe(true);
    for (let i = 0; i < 20; i++) await flush();
    expect(w.calls.events).toBe(ticks);
  });

  test('켜지 않았으면 stop은 바로 끝나고 두 번 불러도 된다', async () => {
    const w = world();
    const r = w.relay();
    await r.stop();
    await r.stop();
    expect(w.calls.events).toBe(0);
  });

  test('NFR015_실패가 있던 틱 뒤에는 쉬기가 0.2초에서 두 배씩 5초까지 늘고, 성공한 틱 뒤에는 1초로 돌아간다(다음 실패는 다시 0.2초부터)', async () => {
    expect(STREAM_RELAY_TICK_MS).toBe(1_000);
    expect(STREAM_RELAY_BACKOFF_MIN_MS).toBe(200);
    expect(STREAM_RELAY_BACKOFF_MAX_MS).toBe(5_000);
    const w = world({ [EV_A]: [held('1762225200000-0', 1)] });
    // 1~7번째 틱은 publish 실패, 8번째에 보내고 확인, 9번째는 읽을 것이 없음, 10번째는 새 항목의 publish 실패, 11번째에 보냄
    w.hooks.onEvents = (n) => {
      if (n === 10) w.add(EV_A, held('1762225210000-0', 2));
    };
    w.fail.publish = () => (w.calls.events <= 7 || w.calls.events === 10 ? new Error('kafka down') : undefined);
    const r = w.relay();
    r.start();
    const sleepsAfterTicks = () => {
      const out: number[] = [];
      for (let i = 0; i < w.log.length; i++) {
        if (w.log[i] !== 'tick') continue;
        const next = w.log.slice(i + 1).find((x) => x === 'tick' || typeof x === 'number');
        if (typeof next === 'number') out.push(next);
      }
      return out;
    };
    for (let i = 0; i < 100 && sleepsAfterTicks().length < 11; i++) {
      await settle(() => w.pendingSleeps().length > 0);
      if (sleepsAfterTicks().length >= 11) break;
      w.pendingSleeps()[0]?.release();
    }
    await r.stop();
    expect(sleepsAfterTicks().slice(0, 11)).toEqual([200, 400, 800, 1600, 3200, 5000, 5000, 1000, 1000, 200, 1000]);
    expect(w.failed.filter((s) => s === 'publish')).toHaveLength(8);
    expect(w.pending.get(EV_A)).toEqual([]);
    expect(w.sleeps.every((s) => s.signal instanceof AbortSignal)).toBe(true);
  });

  test('NFR015_회차 목록 읽기가 실패한 틱 뒤에도 0.2초에서 두 배씩 늘려 쉬고, 성공한 틱 뒤에는 1초로 돌아간다(시험 검토 B가 찾음)', async () => {
    const w = world({ [EV_A]: [] });
    w.fail.events = () => (w.calls.events <= 2 ? new Error('redis down') : undefined);
    const r = w.relay();
    r.start();
    const sleepsAfterTicks = () => {
      const out: number[] = [];
      for (let i = 0; i < w.log.length; i++) {
        if (w.log[i] !== 'tick') continue;
        const next = w.log.slice(i + 1).find((x) => x === 'tick' || typeof x === 'number');
        if (typeof next === 'number') out.push(next);
      }
      return out;
    };
    for (let i = 0; i < 50 && sleepsAfterTicks().length < 3; i++) {
      await settle(() => w.pendingSleeps().length > 0);
      if (sleepsAfterTicks().length >= 3) break;
      w.pendingSleeps()[0]?.release();
    }
    await r.stop();
    expect(sleepsAfterTicks().slice(0, 3)).toEqual([200, 400, 1000]);
    expect(w.failed.filter((x) => x === 'read')).toHaveLength(2);
  });

  test('코드 리뷰_묶음이 꽉 차면 한 틱 안에서 다음 묶음을 이어 읽어 밀린 항목을 비운다(회차마다 초당 100항목에 묶이지 않는다). 상한(STREAM_RELAY_MAX_BATCHES 묶음)에 닿으면 쉬지 않고 바로 다음 틱을 돈다 [ASVS v5.0.0-15.2.2]', async () => {
    expect(STREAM_RELAY_MAX_BATCHES).toBeGreaterThanOrEqual(10);
    const n = 250;
    const w = world({ [EV_A]: Array.from({ length: n }, (_, i) => held(`1762225200000-${i}`, i + 1)) });
    const r = w.relay();
    const t = await r.tick();
    expect(t.events).toEqual([{ eventId: EV_A, sent: n, dropped: 0, acked: n }]);
    expect(w.calls.publish.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(w.pending.get(EV_A)).toEqual([]);

    // 상한보다 많이 밀렸으면 쉬지 않고(0ms) 바로 다음 틱
    const many = STREAM_RELAY_MAX_BATCHES * 100 + 10;
    const w2 = world({ [EV_A]: Array.from({ length: many }, (_, i) => held(`1762225300000-${i}`, i + 1)) });
    const r2 = w2.relay();
    r2.start();
    await settle(() => w2.sleeps.length >= 1);
    await r2.stop();
    expect(w2.sleeps[0]!.ms, '밀린 항목이 남았으면 쉬지 않는다').toBe(0);
  });

  test('코드 리뷰_부호기(codec.encode)가 던지는 항목은 malformed로 넘기고 반복이 멈추지 않는다(같은 항목에서 영원히 막히지 않는다) [ASVS v5.0.0-16.5.3]', async () => {
    const entries = [held('1762225200000-0', 1), held('1762225200000-1', 2)];
    const w = world({ [EV_A]: entries });
    const realEncode = w.codec.encode.bind(w.codec);
    let calls = 0;
    w.codec.encode = (topic, message) => {
      calls += 1;
      if (calls === 1) throw new Error('schema mismatch');
      return realEncode(topic, message);
    };
    const r = w.relay();
    const t = await r.tick();
    expect(t.events).toEqual([{ eventId: EV_A, sent: 1, dropped: 1, acked: 2 }]);
    expect(w.dropped).toEqual(['malformed']);
    expect(w.pending.get(EV_A)).toEqual([]);
  });

  test('코드 리뷰_틱 자체가 던져도(예상 밖 오류) 반복은 늘려 쉰 뒤 이어 돈다(처리되지 않은 거부로 끝나지 않는다)', async () => {
    const w = world({ [EV_A]: [] });
    const r = w.relay();
    let n = 0;
    const realTick = r.tick.bind(r);
    r.tick = async () => {
      n += 1;
      if (n === 1) throw new Error('unexpected');
      return realTick();
    };
    r.start();
    for (let i = 0; i < 20 && w.sleeps.length < 2; i++) {
      await settle(() => w.pendingSleeps().length > 0);
      if (w.sleeps.length >= 2) break;
      w.pendingSleeps()[0]?.release();
    }
    await r.stop();
    expect(w.sleeps.slice(0, 2).map((s) => s.ms)).toEqual([200, 1000]);
  });

  test('코드 리뷰_실패 지표는 틱마다 단계당 한 번이다(회차가 여럿 실패해도 failed(publish) 한 번)', async () => {
    const w = world({ [EV_A]: [held('1762225200000-0', 1)], [EV_B]: [held('1762225200001-0', 2)] });
    w.fail.publish = () => new Error('kafka down');
    await w.relay().tick();
    expect(w.failed).toEqual(['publish']);
  });
});

// ── 리더 확인(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 리더 반복, docs/data.md §5 '릴레이 리더 넘김') ──
// 릴레이 프로세스의 leaderLoops가 LeaderLoopContext.leader를 deps.leader로 넘긴다. 반복(start)은 틱마다 리더를 다시 보고, 리더가 아니면 회차 목록도 읽지 않는다.
describe('SeatStreamRelay: 리더 확인(PRF-164)', () => {
  test('ST5_leader가 거짓이면 반복이 tick을 부르지 않고(회차 목록·Stream을 읽지 않는다) STREAM_RELAY_TICK_MS씩 쉬며, 참이 되면 다음 쉬기 뒤에 다시 돌아 밀린 항목을 보낸다 [ASVS v5.0.0-15.4.1]', async () => {
    const w = world({ [EV_A]: [held('1762225200000-0', 1)] });
    let leader = false;
    let asked = 0;
    const r = w.relay({
      leader: {
        isLeader: () => {
          asked += 1;
          return leader;
        },
      },
    });
    r.start();
    for (let i = 0; i < 4; i++) {
      await settle(() => w.pendingSleeps().length > 0);
      w.pendingSleeps()[0]?.release();
    }
    await settle(() => w.pendingSleeps().length > 0);
    expect(w.calls.events).toBe(0);
    expect(w.calls.read).toEqual([]);
    expect(w.calls.publish).toEqual([]);
    expect(w.sleeps.length).toBeGreaterThanOrEqual(4);
    expect(new Set(w.sleeps.map((s) => s.ms))).toEqual(new Set([STREAM_RELAY_TICK_MS]));
    // 틱마다 다시 본다(처음 한 번만 보지 않는다)
    expect(asked).toBeGreaterThanOrEqual(4);
    leader = true;
    await runUntil(w, () => w.calls.ack.length >= 1);
    await r.stop();
    expect(w.calls.ack).toEqual([[EV_A, ['1762225200000-0']]]);
    expect(w.sentBy(SEAT_TOPIC)).toBe(1);
  });

  test('ST5_리더를 잃으면 실패 뒤 늘려 쉬기도 0으로 돌린다: 실패한 틱 뒤 0.2초 → 리더 아님 1초(0.4초가 아니다) → 다시 리더가 되어 실패하면 0.2초부터 [ASVS v5.0.0-15.4.1]', async () => {
    const w = world({ [EV_A]: [held('1762225200000-0', 1)] });
    w.fail.publish = () => new Error('kafka down');
    let leader = true;
    const r = w.relay({ leader: { isLeader: () => leader } });
    r.start();
    await settle(() => w.pendingSleeps().length > 0);
    expect(w.sleeps.map((s) => s.ms)).toEqual([STREAM_RELAY_BACKOFF_MIN_MS]);
    leader = false;
    w.pendingSleeps()[0]!.release();
    await settle(() => w.pendingSleeps().length > 0);
    expect(w.sleeps.map((s) => s.ms)).toEqual([STREAM_RELAY_BACKOFF_MIN_MS, STREAM_RELAY_TICK_MS]);
    expect(w.calls.events).toBe(1);
    leader = true;
    w.pendingSleeps()[0]!.release();
    await settle(() => w.pendingSleeps().length > 0);
    await r.stop();
    expect(w.sleeps.map((s) => s.ms)).toEqual([STREAM_RELAY_BACKOFF_MIN_MS, STREAM_RELAY_TICK_MS, STREAM_RELAY_BACKOFF_MIN_MS]);
    expect(w.calls.events).toBe(2);
  });

  test('ST5_리더가 아닌 동안 쉬는 중에 stop하면 쉬기를 끊고 바로 끝난다. 그 뒤로 틱이 없다', async () => {
    const w = world({ [EV_A]: [held('1762225200000-0', 1)] });
    const r = w.relay({ leader: { isLeader: () => false } });
    r.start();
    await settle(() => w.pendingSleeps().length > 0);
    await r.stop();
    expect(w.sleeps.every((s) => s.done)).toBe(true);
    expect(w.sleeps.at(-1)!.signal.aborted).toBe(true);
    for (let i = 0; i < 20; i++) await flush();
    expect(w.calls.events).toBe(0);
  });

  test('ST5_리더 확인이 던지면 리더가 아닌 것으로 본다: 회차 목록·Stream을 읽지 않고 경고 한 줄(오류 이름만) 뒤 STREAM_RELAY_TICK_MS 쉬며 반복은 끝나지 않고, 확인이 다시 참이면 밀린 항목을 보낸다 [ASVS v5.0.0-15.4.1] [ASVS v5.0.0-16.5.2]', async () => {
    // 변이 검토(PRF-164): 확인이 던질 때 리더로 보면 두 파드가 같은 소비자 이름으로 Stream을 읽어 순서가 깨질 수 있다
    const w = world({ [EV_A]: [held('1762225200000-0', 1)] });
    let broken = true;
    const r = w.relay({
      leader: {
        isLeader: () => {
          if (broken) throw Object.assign(new Error('lease api https://kube:SECRET'), { name: 'LeaseCheckError' });
          return true;
        },
      },
    });
    r.start();
    for (let i = 0; i < 3; i++) {
      await settle(() => w.pendingSleeps().length > 0);
      w.pendingSleeps()[0]?.release();
    }
    await settle(() => w.pendingSleeps().length > 0);
    expect(w.calls.events).toBe(0);
    expect(w.calls.read).toEqual([]);
    expect(w.calls.publish).toEqual([]);
    expect(new Set(w.sleeps.map((s) => s.ms))).toEqual(new Set([STREAM_RELAY_TICK_MS]));
    expect(w.lines.length).toBeGreaterThanOrEqual(3);
    expect(w.lines.every((l) => Object.values(l.obj).includes('LeaseCheckError'))).toBe(true);
    expect(w.logText()).not.toContain('SECRET');
    broken = false;
    await runUntil(w, () => w.calls.ack.length >= 1);
    await r.stop();
    expect(w.calls.ack).toEqual([[EV_A, ['1762225200000-0']]]);
  });

  test('ST5_직접 부르는 tick()은 리더를 보지 않는다(시험·도구용): leader가 거짓이어도 보내고 확인한다', async () => {
    const w = world({ [EV_A]: [held('1762225200000-0', 1)] });
    let asked = 0;
    const r = w.relay({
      leader: {
        isLeader: () => {
          asked += 1;
          return false;
        },
      },
    });
    expect((await r.tick()).events).toEqual([{ eventId: EV_A, sent: 1, dropped: 0, acked: 1 }]);
    expect(asked).toBe(0);
  });

  test('ST5_leader가 없으면 지금처럼 늘 돈다(틱 사이 STREAM_RELAY_TICK_MS). 플랫폼 LeaderLoop 모양(name seat-stream-relay·start·stop)이다', async () => {
    const w = world({ [EV_A]: [] });
    const r = w.relay();
    expect(r.name).toBe('seat-stream-relay');
    expect(typeof r.start).toBe('function');
    expect(typeof r.stop).toBe('function');
    r.start();
    await runUntil(w, () => w.calls.events >= 3);
    await r.stop();
    expect(w.calls.events).toBeGreaterThanOrEqual(3);
    expect(w.sleeps.slice(0, 2).map((s) => s.ms)).toEqual([STREAM_RELAY_TICK_MS, STREAM_RELAY_TICK_MS]);
  });
});

// ── 리더를 잃은 틱(PRF-164 리뷰 고침 M2·L8, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 리더를 잃은 틱, docs/data.md §5 '릴레이 리더 넘김') ──
// 반복(start)이 부른 틱은 회차 사이·묶음 사이마다 리더 확인과 멈춤 신호를 다시 보고, 리더가 아니거나 멈추면 그 틱을 끝낸다.
// 보낸 묶음은 확인·지움까지 마친다(보내기 중간에 끊지 않는다). 그래서 옛 리더와 새 리더가 함께 보내는 것은 묶음 하나와 그 보내기 시간까지다.
describe('SeatStreamRelay: 리더를 잃은 틱(PRF-164 리뷰 고침)', () => {
  const EV_C = '0190f3a1-7c2e-7a00-8000-0000000000e3';
  const ids = { a: '1762225200000-0', b: '1762225200001-0', c: '1762225200002-0' };
  /** 회차 셋, 회차마다 항목 하나(목록 차례 A·B·C) */
  const three = () => ({ [EV_A]: [held(ids.a, 1)], [EV_B]: [held(ids.b, 2)], [EV_C]: [held(ids.c, 3)] });

  test('ST5_리뷰 고침 M2_회차 셋 가운데 첫 회차를 보내는 동안 리더를 잃으면 반복의 틱은 그 묶음의 확인·지움까지 마치고 둘째·셋째 회차를 읽지 않는다. 직접 부르는 tick()은 같은 상황에서도 셋 다 보낸다 [ASVS v5.0.0-15.4.1]', async () => {
    const w = world(three());
    let leader = true;
    // 첫 보내기 도중에 Lease를 잃는다(보내기는 끝까지 간다)
    w.wait.publish = async () => {
      leader = false;
    };
    const r = w.relay({ leader: { isLeader: () => leader } });
    r.start();
    await settle(() => w.calls.ack.length >= 1 && w.pendingSleeps().length > 0);
    for (let i = 0; i < 10; i++) await flush();
    expect(w.calls.read).toEqual([[EV_A, STREAM_RELAY_BATCH]]);
    expect(w.calls.publish).toHaveLength(1);
    expect(w.calls.ack).toEqual([[EV_A, [ids.a]]]);
    expect(w.pending.get(EV_B)).toHaveLength(1);
    expect(w.pending.get(EV_C)).toHaveLength(1);
    await r.stop();

    // 직접 부르는 tick()은 리더를 보지 않는다(시험·도구용)
    const d = world(three());
    let dLeader = true;
    d.wait.publish = async () => {
      dLeader = false;
    };
    const direct = d.relay({ leader: { isLeader: () => dLeader } });
    expect((await direct.tick()).events.map((e) => [e.eventId, e.acked])).toEqual([
      [EV_A, 1],
      [EV_B, 1],
      [EV_C, 1],
    ]);
  });

  test('ST5_리뷰 고침 M2_한 회차의 묶음 사이에도 다시 본다: 꽉 찬 묶음(batch 1)을 보내는 동안 리더를 잃으면 다음 묶음을 읽지 않는다 [ASVS v5.0.0-15.4.1]', async () => {
    const w = world({ [EV_A]: [held(ids.a, 1), held(ids.b, 2), held(ids.c, 3)] });
    let leader = true;
    w.wait.publish = async () => {
      leader = false;
    };
    const r = w.relay({ batch: 1, leader: { isLeader: () => leader } });
    r.start();
    await settle(() => w.calls.ack.length >= 1 && w.pendingSleeps().length > 0);
    for (let i = 0; i < 10; i++) await flush();
    expect(w.calls.read).toEqual([[EV_A, 1]]);
    expect(w.calls.ack).toEqual([[EV_A, [ids.a]]]);
    expect(w.pending.get(EV_A)).toHaveLength(2);
    await r.stop();
  });

  test('ST5_리뷰 고침 M2_리더 확인이 틱 도중에 던지면 리더가 아닌 것으로 보고 그 틱을 끝낸다(남은 회차를 읽지 않는다) [ASVS v5.0.0-15.4.1]', async () => {
    const w = world(three());
    let broken = false;
    w.wait.publish = async () => {
      broken = true;
    };
    const r = w.relay({
      leader: {
        isLeader: () => {
          if (broken) throw Object.assign(new Error('lease api'), { name: 'LeaseCheckError' });
          return true;
        },
      },
    });
    r.start();
    await settle(() => w.calls.ack.length >= 1 && w.pendingSleeps().length > 0);
    for (let i = 0; i < 10; i++) await flush();
    expect(w.calls.read.map(([e]) => e)).toEqual([EV_A]);
    expect(w.calls.ack).toEqual([[EV_A, [ids.a]]]);
    await r.stop();
  });

  test('ST5_리뷰 고침 M2_멈춤 신호도 같다: 첫 회차를 보내는 동안 stop()을 부르면 그 묶음의 확인·지움까지 마치고 남은 회차를 읽지 않으며 stop()이 곧 끝난다(뒤 회차의 보내기를 기다리지 않는다) [ASVS v5.0.0-16.5.2]', async () => {
    const w = world(three());
    const gate = deferred();
    let publishes = 0;
    // 첫 보내기는 시험이 풀고, 그 뒤 보내기는 끝나지 않는다(고치기 전에는 stop이 둘째 회차의 보내기에 걸려 끝나지 않는다)
    w.wait.publish = () => {
      publishes += 1;
      return publishes === 1 ? gate.promise : new Promise<void>(() => {});
    };
    const r = w.relay();
    r.start();
    await settle(() => w.calls.publish.length >= 1);
    let stopped = false;
    const p = r.stop().then(() => void (stopped = true));
    gate.resolve();
    await settle(() => stopped);
    expect(stopped).toBe(true);
    await p;
    expect(w.calls.read.map(([e]) => e)).toEqual([EV_A]);
    expect(w.calls.ack).toEqual([[EV_A, [ids.a]]]);
    expect(w.pending.get(EV_B)).toHaveLength(1);
    expect(w.pending.get(EV_C)).toHaveLength(1);
  });

  test('ST5_리뷰 고침 L8_끼운 쉬기가 던져도 반복은 거부로 끝나지 않고 이어 돈다(다음 틱이 돌고 stop이 거부 없이 끝난다)', async () => {
    const w = world({ [EV_A]: [] });
    let thrown = 0;
    const r = w.relay({
      sleep: (ms, signal) => {
        if (thrown === 0) {
          thrown += 1;
          return Promise.reject(Object.assign(new Error('sleep boom'), { name: 'SleepError' }));
        }
        return w.sleep(ms, signal);
      },
    });
    r.start();
    await runUntil(w, () => w.calls.events >= 2);
    expect(thrown).toBe(1);
    expect(w.calls.events).toBeGreaterThanOrEqual(2);
    await expect(r.stop()).resolves.toBeUndefined();
  });
});
