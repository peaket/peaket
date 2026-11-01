// Kafka 클라이언트 필수 설정(openspec 변경 add-maintenance-control-and-consumers 결정 2, ADR-0142 결정 3, docs/streaming.md §2.6 표)
import { describe, expect, test } from 'vitest';
import { KAFKA_REQUIRED, kafkaConsumerConfig, kafkaProducerConfig } from '../src/index.js';

const base = { brokers: ['127.0.0.1:9092'], clientId: 'purchase-svc-ci-pod-1' };

describe('ADR0142 결정3 필수 설정', () => {
  test('D_T45_생산자_Outbox릴레이는_acks_all_멱등_동시5_murmur2_random_전달상한10초다', () => {
    const c = kafkaProducerConfig({ ...base, kind: 'outbox-relay' });
    expect(c).toMatchObject({
      acks: 'all',
      'enable.idempotence': true,
      'max.in.flight.requests.per.connection': 5,
      partitioner: 'murmur2_random',
      'message.timeout.ms': 10_000,
    });
    // KafkaJS 호환 묶음에는 주소와 이름만 둔다(필수 값은 librdkafka 이름으로 위에 둔다)
    expect(c.kafkaJS).toEqual({ brokers: base.brokers, clientId: base.clientId });
  });

  test('D_T45_그밖의생산자는_전달상한5초다', () => {
    expect(kafkaProducerConfig({ ...base, kind: 'default' })['message.timeout.ms']).toBe(5_000);
    expect(KAFKA_REQUIRED.producer.messageTimeoutMs).toEqual({ 'outbox-relay': 10_000, default: 5_000 });
  });

  test('D_T45_소비자는_자동커밋끔_cooperative_sticky_세션45초_classic이고_고정멤버십이없다', () => {
    const c = kafkaConsumerConfig({ ...base, groupId: 'peaket.purchase-svc.ci' });
    expect(c).toMatchObject({
      'group.id': 'peaket.purchase-svc.ci',
      'group.protocol': 'classic',
      'enable.auto.commit': false,
      'partition.assignment.strategy': 'cooperative-sticky',
      'session.timeout.ms': 45_000,
    });
    expect(c).not.toHaveProperty('group.instance.id');
    expect(c.kafkaJS).toEqual({ brokers: base.brokers, clientId: base.clientId });
  });

  test('덧붙일 설정은 그대로 싣는다', () => {
    const c = kafkaConsumerConfig({ ...base, groupId: 'g', extra: { 'auto.offset.reset': 'earliest', 'fetch.wait.max.ms': 100 } });
    expect(c['auto.offset.reset']).toBe('earliest');
    expect(c['fetch.wait.max.ms']).toBe(100);
  });

  test.each([
    ['acks'],
    ['enable.idempotence'],
    ['idempotent'],
    ['max.in.flight.requests.per.connection'],
    ['max.in.flight'],
    ['maxInFlightRequests'],
    ['partitioner'],
    ['message.timeout.ms'],
  ])('D_T45_생산자의필수이름 %s 를덮어쓰면_만들기가실패한다', (name) => {
    expect(() => kafkaProducerConfig({ ...base, kind: 'default', extra: { [name]: 1 } })).toThrow(name);
  });

  test.each([
    ['enable.auto.commit'],
    ['autoCommit'],
    ['partition.assignment.strategy'],
    ['partitionAssigners'],
    ['partitionAssignors'],
    ['session.timeout.ms'],
    ['sessionTimeout'],
    ['group.protocol'],
    ['group.instance.id'],
    ['groupInstanceId'],
    ['group.id'],
  ])('D_T45_소비자의필수이름 %s 를덮어쓰면_만들기가실패한다', (name) => {
    expect(() => kafkaConsumerConfig({ ...base, groupId: 'g', extra: { [name]: 'x' } })).toThrow(name);
  });

  test('KafkaJS 호환 묶음을 덧붙이면 실패한다(호환 변환이 필수 값을 바꾼다)', () => {
    expect(() => kafkaProducerConfig({ ...base, kind: 'default', extra: { kafkaJS: { acks: 1 } } })).toThrow('kafkaJS');
  });
});
