// Kafka 클라이언트 필수 설정(openspec 변경 add-maintenance-control-and-consumers 결정 2, ADR-0142 결정 3, docs/streaming.md §2.6 표).
// 쓰는 클라이언트 @confluentinc/kafka-javascript의 KafkaJS 호환 묶음(kafkaJS)은 값이 없으면 문서와 다른 기본값을 넣는다
// (멱등 생산 꺼짐, 자동 커밋 켬, round-robin 재조정, 세션 30초). 그래서 필수 값은 librdkafka 이름으로 겉에 두고(겉의 값이 이긴다)
// 호환 묶음에는 브로커 주소와 이름만 둔다. 이 파일은 네이티브 모듈을 싣지 않는다(설정만 만든다).
// MSK IAM(openspec 변경 add-foundation-poc, docs/streaming.md §2.6): 인증을 고르면 호환 묶음에 TLS와 OAUTHBEARER 토큰 함수를 싣는다.
// 클라이언트가 그 둘에서 security.protocol=sasl_ssl을 만든다(@confluentinc/kafka-javascript 1.11.0 lib/kafkajs/_common.js).
import type { KafkaAuth } from './msk-iam.js';

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
  /** 필수 이름이 아닌 librdkafka 설정(예: linger.ms, auto.offset.reset) */
  extra?: Extra;
  /** 없으면 평문(로컬·CI 브로커). 운영은 MSK IAM(kafkaAuthFromEnv) */
  auth?: KafkaAuth;
}

export interface KafkaClientConfig extends Record<string, unknown> {
  kafkaJS: { brokers: string[]; clientId: string; ssl?: true; sasl?: { mechanism: 'oauthbearer'; oauthBearerProvider: KafkaAuth['tokenProvider'] } };
}

/** 인증을 고른 설정에서 덧붙일 수 없는 이름(겉의 librdkafka 값이 호환 묶음에서 만든 값을 이긴다) */
export const KAFKA_AUTH_LOCKED = [
  'security.protocol',
  'sasl.mechanism',
  'sasl.mechanisms',
  'sasl.oauthbearer.config',
  'sasl.oauthbearer.method',
  'enable.sasl.oauthbearer.unsecure.jwt',
  'oauthbearer_token_refresh_cb',
  // TLS 인증서 검증을 끄거나 믿을 CA를 바꾸면 중간에서 토큰을 가로채 그대로 쓸 수 있다(코드 리뷰 2026-11-01). CA는 auth.caLocation으로만 받는다
  'enable.ssl.certificate.verification',
  'ssl.endpoint.identification.algorithm',
  'ssl.ca.location',
  'ssl.ca.pem',
  'ssl.ca.certificate.stores',
] as const;

function checkExtra(extra: Extra | undefined, locked: readonly string[], side: string, auth?: KafkaAuth): Extra {
  const out: Extra = {};
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (auth && (KAFKA_AUTH_LOCKED as readonly string[]).includes(k)) throw new Error(`Kafka ${side} 인증 설정 ${k}는 덧붙일 수 없다(MSK IAM을 골랐다)`);
    if (k === 'kafkaJS') throw new Error(`Kafka ${side} 설정에 kafkaJS 묶음을 덧붙일 수 없다(호환 변환이 필수 값을 바꾼다, ADR-0142 결정 3)`);
    if (locked.includes(k)) throw new Error(`Kafka ${side} 필수 설정 ${k}는 바꿀 수 없다(ADR-0142 결정 3, D-T45)`);
    out[k] = v;
  }
  return out;
}

/** 인증 묶음이 정하는 겉의 librdkafka 값(사설 CA) */
function authTop(o: Pick<KafkaClientBase, 'auth'>): Record<string, unknown> {
  return o.auth?.caLocation ? { 'ssl.ca.location': o.auth.caLocation } : {};
}

function kafkaJsOf(o: Pick<KafkaClientBase, 'brokers' | 'clientId' | 'auth'>): KafkaClientConfig['kafkaJS'] {
  if (!o.auth) return { brokers: o.brokers, clientId: o.clientId };
  if (o.auth.mechanism !== 'msk-iam') throw new Error(`모르는 Kafka 인증: ${String(o.auth.mechanism)}`);
  return { brokers: o.brokers, clientId: o.clientId, ssl: true, sasl: { mechanism: 'oauthbearer', oauthBearerProvider: o.auth.tokenProvider } };
}

export function kafkaProducerConfig(o: KafkaClientBase & { kind: KafkaProducerKind }): KafkaClientConfig {
  const p = KAFKA_REQUIRED.producer;
  const timeout = p.messageTimeoutMs[o.kind];
  if (timeout === undefined) throw new Error(`알 수 없는 생산자 종류: ${String(o.kind)}`);
  return {
    ...checkExtra(o.extra, KAFKA_PRODUCER_LOCKED, '생산자', o.auth),
    ...authTop(o),
    kafkaJS: kafkaJsOf(o),
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
    ...checkExtra(o.extra, KAFKA_CONSUMER_LOCKED, '소비자', o.auth),
    ...authTop(o),
    kafkaJS: kafkaJsOf(o),
    'group.id': o.groupId,
    'group.protocol': c.groupProtocol,
    'enable.auto.commit': c.autoCommit,
    'partition.assignment.strategy': c.assignment,
    'session.timeout.ms': c.sessionTimeoutMs,
  };
}

/** 관리 연결(토픽 만들기·위치 읽기). 필수 값은 없고 인증만 같다(코드 리뷰 2026-11-01: 관리 연결에 인증을 줄 길이 없었다) */
export function kafkaAdminConfig(o: Pick<KafkaClientBase, 'brokers' | 'clientId' | 'auth'>): KafkaClientConfig {
  return { ...authTop(o), kafkaJS: kafkaJsOf(o) };
}
