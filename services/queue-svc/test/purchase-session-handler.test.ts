// trade.purchase-sessions 사건의 JSON 값을 읽어 입장 자리를 고치는 처리기(BUILD_ORDER PRF-136, docs/features/queue-admission.md §6 '구매 세션 사건', ADR-0183 결정 11).
// Avro 해독은 BAS-030, Kafka 구독 실행은 HOT-010이다. 이 처리기는 플랫폼 키 단위 소비자(KeyedHandler)에 꽂는 면이고, 값 해독만 JSON 대역(PurchaseSessionCodec)이다.
import { randomUUID } from 'node:crypto';
import { type ConsumedMessage, isTransientError, systemClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryAdmissionStore } from '../src/modules/admission/adapters/memory-admission-store.js';
import { PurchaseSessionSlots } from '../src/modules/admission/application/purchase-session-slots.js';
import { PurchaseSessionHandler, jsonPurchaseSessionCodec } from '../src/modules/admission/inbound/purchase-session.handler.js';
import { QueueStoreUnavailable } from '../src/modules/entry/index.js';
import { JNY, newEvent } from './support.js';

const msg = (value: unknown, over: Partial<ConsumedMessage> = {}): ConsumedMessage => ({
  topic: 'trade.purchase-sessions',
  partition: 0,
  offset: 1n,
  key: 'ev',
  value: value === null ? null : Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'),
  headers: {},
  timestamp: Date.now(),
  ...over,
});

function setup() {
  const store = new MemoryAdmissionStore(systemClock);
  const handler = new PurchaseSessionHandler(new PurchaseSessionSlots(store), jsonPurchaseSessionCodec);
  const eventId = newEvent();
  return { store, handler, eventId };
}

const started = (eventId: string, jti: string, maxStayUntil: string, over: Record<string, unknown> = {}) => ({
  eventId,
  purchaseSessionId: jti,
  admissionJti: jti,
  journeyId: JNY,
  startedAt: new Date().toISOString(),
  maxStayUntil,
  eventKey: randomUUID(),
  ...over,
});
const ended = (eventId: string, jti: string, over: Record<string, unknown> = {}) => ({
  eventId,
  purchaseSessionId: jti,
  admissionJti: jti,
  reason: 'LEFT',
  endedAt: new Date().toISOString(),
  eventKey: randomUUID(),
  ...over,
});

describe('PurchaseSessionHandler (trade.purchase-sessions → 입장 자리)', () => {
  test('ADR0183_11_Q_T11_PurchaseSessionStarted JSON은 남은 자리를 최대 체류 시각으로 올린다. 업무 키는 입장 토큰 jti, 중복 제거 키는 eventKey다', async () => {
    const { store, handler, eventId } = setup();
    store.db.slots(eventId).set('j-1', Date.now() + 60_000);
    const maxStayUntil = new Date(Date.now() + 45 * 60_000).toISOString();
    const value = started(eventId, 'j-1', maxStayUntil);
    const m = msg(value);
    const e = await handler.decode(m);
    expect(e.kind).toBe('STARTED');
    expect(handler.keyOf(e, m)).toBe('j-1');
    expect(handler.eventKeyOf?.(e)).toBe(value.eventKey);
    await handler.handle(e, m);
    expect(store.db.slots(eventId).get('j-1')).toBe(Date.parse(maxStayUntil));
  });

  test('ADR0183_11_이미 회수된 자리는 늦게 온 시작 사건이 되살리지 않는다(오류도 아니다)', async () => {
    const { store, handler, eventId } = setup();
    const m = msg(started(eventId, 'j-gone', new Date(Date.now() + 45 * 60_000).toISOString()));
    await handler.handle(await handler.decode(m), m);
    expect(store.db.slots(eventId).size).toBe(0);
  });

  test('ADR0183_11_PurchaseSessionEnded JSON은 자리를 바로 뺀다. 같은 사건을 다시 받아도 오류가 아니다', async () => {
    const { store, handler, eventId } = setup();
    store.db.slots(eventId).set('j-2', Date.now() + 60_000);
    for (const reason of ['COMPLETED', 'LEFT', 'IDLE', 'MAX_STAY']) {
      store.db.slots(eventId).set('j-2', Date.now() + 60_000);
      const m = msg(ended(eventId, 'j-2', { reason }));
      const e = await handler.decode(m);
      expect(e.kind).toBe('ENDED');
      await handler.handle(e, m);
      expect(store.db.slots(eventId).has('j-2'), reason).toBe(false);
      await handler.handle(e, m);
    }
  });

  test('ADR0183_11_읽을 수 없는 값은 decode가 던진다(키 단위 소비자가 그 키를 보류한다): 값 없음, JSON 아님, 객체 아님, 두 종류 어느 쪽도 아님, 날짜 아님, 칸 빠짐, 모르는 종료 이유', async () => {
    const { handler, eventId } = setup();
    const good = started(eventId, 'j-3', new Date(Date.now() + 60_000).toISOString());
    const { eventKey: _k, ...noEventKey } = good;
    const bad: unknown[] = [
      null,
      'not json',
      '[]',
      '"x"',
      '7',
      {},
      { eventId, admissionJti: 'j-3' },
      started(eventId, 'j-3', 'not-a-date'),
      noEventKey,
      { ...good, journeyId: 'nope' },
      ended(eventId, 'j-3', { reason: 'UNKNOWN' }),
      ended(eventId, 'j-3', { endedAt: 'x' }),
      { ...good, ...ended(eventId, 'j-3') }, // 두 종류의 칸이 섞임
    ];
    for (const v of bad) await expect(Promise.resolve().then(() => handler.decode(msg(v))), JSON.stringify(v)).rejects.toThrow();
  });

  test('ADR0183_11_모르는 칸이 더 있어도(앞으로 호환되는 칸 추가) 읽는다', async () => {
    const { handler, eventId } = setup();
    const e = await handler.decode(msg({ ...started(eventId, 'j-4', new Date(Date.now() + 60_000).toISOString()), futureField: 1 }));
    expect(e.kind).toBe('STARTED');
  });

  test('ADR0183_11_처리기는 저장소 오류를 숨기지 않는다: 시작 날짜가 읽히지 않는 값은 던진다', async () => {
    const store = new MemoryAdmissionStore(systemClock);
    const slots = new PurchaseSessionSlots(store);
    const handler = new PurchaseSessionHandler(slots, jsonPurchaseSessionCodec);
    const eventId = newEvent();
    const e = await handler.decode(msg(started(eventId, 'j-5', new Date(Date.now() + 60_000).toISOString())));
    // 해독을 지난 뒤 값이 망가진 경우(방어): 날짜 칸을 바꿔 처리기를 부른다
    await expect(handler.handle({ ...e, value: { ...e.value, maxStayUntil: 'x' } } as never, msg({}))).rejects.toThrow('maxStayUntil');
  });
});

describe('PurchaseSessionHandler (PRF-136 리뷰: 대기열 Redis 장애와 회차 ID 모양)', () => {
  test('ADR0183_11_대기열 Redis 일시 장애(QueueStoreUnavailable)는 일시 실패로 바꿔 던진다: 시작·종료 모두. 키 단위 소비자가 사건을 보류하지 않고 다시 한다', async () => {
    const { store, handler, eventId } = setup();
    const down = new QueueStoreUnavailable(new Error('connection refused'));
    store.sessionStarted = async () => {
      throw down;
    };
    store.sessionEnded = async () => {
      throw down;
    };
    // 바꾸기 전에는 QueueStoreUnavailable 그대로라 일시 실패로 읽히지 않는다(원인 Redis 오류에 코드가 없다)
    expect(isTransientError(down)).toBe(false);
    const ms = msg(started(eventId, 'j-6', new Date(Date.now() + 60_000).toISOString()));
    const me = msg(ended(eventId, 'j-6'));
    for (const m of [ms, me]) {
      const e = await handler.decode(m);
      const err = await handler.handle(e, m).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(err).toBeInstanceOf(Error);
      expect(isTransientError(err)).toBe(true);
      expect((err as Error).cause).toBe(down);
    }
  });

  test('ADR0183_11_일시 장애가 아닌 저장소 오류(버그)는 일시 실패로 바꾸지 않는다', async () => {
    const { store, handler, eventId } = setup();
    store.sessionStarted = async () => {
      throw new Error('ERR script bug');
    };
    const m = msg(started(eventId, 'j-7', new Date(Date.now() + 60_000).toISOString()));
    const err = await handler.handle(await handler.decode(m), m).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(Error);
    expect(isTransientError(err)).toBe(false);
  });

  test('ADR0183_11_ASVS1.2.4_회차 ID가 키 조각 모양(영문·숫자·_-, 1~64자)이 아니면 decode가 던진다: 해시 태그를 깨는 값이 Redis 키로 가지 않게 [ASVS v5.0.0-1.2.4]', async () => {
    const { handler } = setup();
    const at = new Date(Date.now() + 60_000).toISOString();
    for (const bad of ['a}b', '{x}', 'a:b', 'a b', 'x'.repeat(65), 'é', '']) {
      await expect(Promise.resolve().then(() => handler.decode(msg(started(bad, 'j-8', at)))), `시작 ${bad}`).rejects.toThrow();
      await expect(Promise.resolve().then(() => handler.decode(msg(ended(bad, 'j-8')))), `종료 ${bad}`).rejects.toThrow();
    }
    for (const ok of ['ev-1', 'A_b-9', 'x'.repeat(64)]) {
      expect((await handler.decode(msg(started(ok, 'j-8', at)))).kind).toBe('STARTED');
    }
  });
});
