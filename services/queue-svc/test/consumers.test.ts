// queue-svc Kafka 구독(docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', docs/streaming.md §2.6, ADR-0214 결정 1).
// 토픽 셋을 한 처리기가 나눠 맡는지와 설정 읽기를 본다. 실제 브로커로 도는 것은 test-int/consumers.int.test.ts다.
import type { ConsumedMessage, KeyedHandler } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { ACCOUNTS_WITHDRAWN_TOPIC, kafkaConsumersFromEnv, PURCHASE_SESSIONS_TOPIC, QUEUE_GROUP, QUEUE_TOPICS, QueueEventsHandler } from '../src/consumers/queue-events.js';
import { SEATS_TOPIC } from '../src/modules/sale/index.js';

const msg = (topic: string, key = 'k'): ConsumedMessage => ({ topic, partition: 0, offset: 1n, key, value: Buffer.from('{}'), headers: {}, timestamp: 0 });

/** 받은 차례를 남기는 가짜 처리기 */
function fake(name: string, seen: string[]): KeyedHandler<{ from: string }> {
  return {
    decode: () => ({ from: name }),
    keyOf: () => `${name}-key`,
    eventKeyOf: () => `${name}-event`,
    handle: async (e) => void seen.push(`${name}:${e.from}`),
  };
}

describe('토픽 셋을 나눠 맡는 처리기', () => {
  test('ST-T18_토픽마다그처리기의읽기·업무키·중복제거키·처리를쓴다', async () => {
    const seen: string[] = [];
    const h = new QueueEventsHandler({ purchaseSessions: fake('ps', seen), accountsWithdrawn: fake('aw', seen), saleChanged: fake('sc', seen) });
    for (const [topic, name] of [
      [PURCHASE_SESSIONS_TOPIC, 'ps'],
      [ACCOUNTS_WITHDRAWN_TOPIC, 'aw'],
      [SEATS_TOPIC, 'sc'],
    ] as const) {
      const m = msg(topic);
      const e = await h.decode(m);
      expect(h.keyOf(e, m)).toBe(`${name}-key`);
      expect(h.eventKeyOf(e)).toBe(`${name}-event`);
      await h.handle(e, m);
    }
    expect(seen).toEqual(['ps:ps', 'aw:aw', 'sc:sc']);
    expect(QUEUE_TOPICS).toEqual([PURCHASE_SESSIONS_TOPIC, ACCOUNTS_WITHDRAWN_TOPIC, SEATS_TOPIC]);
    expect(QUEUE_GROUP('prod')).toBe('peaket.queue-svc.prod');
  });

  test('모르는토픽의사건은_읽어둔뒤handle이RangeError로던져보류된다', async () => {
    const h = new QueueEventsHandler({ purchaseSessions: fake('ps', []), accountsWithdrawn: fake('aw', []), saleChanged: fake('sc', []) });
    const m = msg('other.topic', 'x');
    const e = await h.decode(m);
    expect(h.keyOf(e, m)).toBe('bad:other.topic:x');
    await expect(h.handle(e, m)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('Kafka 설정 읽기', () => {
  test('브로커주소가없으면_local·ci만경고로끄고_그밖은시작에실패한다', () => {
    expect(kafkaConsumersFromEnv({ PEAKET_ENV: 'local' })).toMatchObject({ enabled: false });
    expect(kafkaConsumersFromEnv({ PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: ' ' })).toMatchObject({ enabled: false });
    expect(() => kafkaConsumersFromEnv({ PEAKET_ENV: 'prod' })).toThrow(/PEAKET_KAFKA_BROKERS/);
    expect(() => kafkaConsumersFromEnv({})).toThrow(/PEAKET_KAFKA_BROKERS/);
  });

  test('브로커주소는쉼표로나눈호스트:포트이고_틀린조각은값대신몇번째인지만알린다', () => {
    expect(kafkaConsumersFromEnv({ PEAKET_ENV: 'local', PEAKET_KAFKA_BROKERS: 'a:9092, b.c:9093' })).toEqual({ enabled: true, brokers: ['a:9092', 'b.c:9093'], auth: undefined, env: 'local' });
    expect(() => kafkaConsumersFromEnv({ PEAKET_ENV: 'local', PEAKET_KAFKA_BROKERS: 'a:9092,secret@host' })).toThrow(/2번째/);
    expect(() => kafkaConsumersFromEnv({ PEAKET_ENV: 'local', PEAKET_KAFKA_BROKERS: 'a:9092,secret@host' })).not.toThrow(/secret/);
  });
});
