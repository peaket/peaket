// Kafka 클라이언트 필수 설정(openspec 변경 add-maintenance-control-and-consumers 결정 2, ADR-0142 결정 3, docs/streaming.md §2.6 표).
// 쓰는 클라이언트 @confluentinc/kafka-javascript의 KafkaJS 호환 묶음(kafkaJS)은 값이 없으면 문서와 다른 기본값을 넣는다
// (멱등 생산 꺼짐, 자동 커밋 켬, round-robin 재조정, 세션 30초). 그래서 필수 값은 librdkafka 이름으로 겉에 두고(겉의 값이 이긴다)
// 호환 묶음에는 브로커 주소와 이름만 둔다. 이 파일은 네이티브 모듈을 싣지 않는다(설정만 만든다).

/** 필수 값. 바꾸면 D-T45(tools/ci/check-kafka-settings.mjs)와 docs/streaming.md §2.6을 같이 고친다 */
export const KAFKA_REQUIRED = {
  producer: {
    acks: 'all',
    idempotence: true,
    maxInFlight: 5,
    partitioner: 'murmur2_random',
    /** 전달 상한: Outbox 릴레이 10초(architecture §5 'Kafka 보내기 상한'), 그 밖 5초 [가정] */
    messageTimeoutMs: { 'outbox-relay': 10_000, default: 5_000 },
  },
  consumer: {
    groupProtocol: 'classic',
    autoCommit: false,
    assignment: 'cooperative-sticky',
    sessionTimeoutMs: 45_000,
  },
} as const;

/** 덧붙일 설정에 넣으면 안 되는 이름(librdkafka 이름과 KafkaJS 호환 별칭). D-T45 검사도 같은 목록을 쓴다 */
export const KAFKA_PRODUCER_LOCKED = [
  'acks',
  'request.required.acks',
  'enable.idempotence',
  'idempotent',
  'max.in.flight.requests.per.connection',
  'max.in.flight',
  'maxInFlightRequests',
  'partitioner',
  'createPartitioner',
  'message.timeout.ms',
  'delivery.timeout.ms',
] as const;
export const KAFKA_CONSUMER_LOCKED = [
  'group.id',
  'groupId',
  'enable.auto.commit',
  'autoCommit',
  'partition.assignment.strategy',
  'partitionAssigners',
  'partitionAssignors',
  'session.timeout.ms',
  'sessionTimeout',
  'group.protocol',
  'group.instance.id',
  'groupInstanceId',
] as const;

export type KafkaProducerKind = keyof typeof KAFKA_REQUIRED.producer.messageTimeoutMs;
type Extra = Record<string, unknown>;

export interface KafkaClientBase {
  /** 'host:port' 목록 */
  brokers: string[];
  /** `<서비스>-<환경>-<파드>`(docs/streaming.md §2.6) */
  clientId: string;
  /** 필수 이름이 아닌 librdkafka 설정(예: linger.ms, auto.offset.reset). 인증(MSK IAM)은 FND-120에서 더한다 */
  extra?: Extra;
}

export interface KafkaClientConfig extends Record<string, unknown> {
  kafkaJS: { brokers: string[]; clientId: string };
}

function checkExtra(extra: Extra | undefined, locked: readonly string[], side: string): Extra {
  const out: Extra = {};
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (k === 'kafkaJS') throw new Error(`Kafka ${side} 설정에 kafkaJS 묶음을 덧붙일 수 없다(호환 변환이 필수 값을 바꾼다, ADR-0142 결정 3)`);
    if (locked.includes(k)) throw new Error(`Kafka ${side} 필수 설정 ${k}는 바꿀 수 없다(ADR-0142 결정 3, D-T45)`);
    out[k] = v;
  }
  return out;
}

export function kafkaProducerConfig(o: KafkaClientBase & { kind: KafkaProducerKind }): KafkaClientConfig {
  const p = KAFKA_REQUIRED.producer;
  const timeout = p.messageTimeoutMs[o.kind];
  if (timeout === undefined) throw new Error(`알 수 없는 생산자 종류: ${String(o.kind)}`);
  return {
    ...checkExtra(o.extra, KAFKA_PRODUCER_LOCKED, '생산자'),
    kafkaJS: { brokers: o.brokers, clientId: o.clientId },
    acks: p.acks,
    'enable.idempotence': p.idempotence,
    'max.in.flight.requests.per.connection': p.maxInFlight,
    partitioner: p.partitioner,
    'message.timeout.ms': timeout,
  };
}

export function kafkaConsumerConfig(o: KafkaClientBase & { groupId: string }): KafkaClientConfig {
  const c = KAFKA_REQUIRED.consumer;
  if (!o.groupId) throw new Error('소비자 그룹 이름이 비었다');
  return {
    ...checkExtra(o.extra, KAFKA_CONSUMER_LOCKED, '소비자'),
    kafkaJS: { brokers: o.brokers, clientId: o.clientId },
    'group.id': o.groupId,
    'group.protocol': c.groupProtocol,
    'enable.auto.commit': c.autoCommit,
    'partition.assignment.strategy': c.assignment,
    'session.timeout.ms': c.sessionTimeoutMs,
  };
}
