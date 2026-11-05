// queue-svc Kafka 구독의 공개 면(HOT-010, ADR-0214). 네이티브 모듈을 싣는 시작 함수는 start.ts에서 따로 가져온다(시험이 그것 없이 처리기만 쓰게).
export { HELD_MAX_PER_TOPIC, HELD_VALUE_MAX_MS, heldExpiry, heldKeys, RedisHeldEventStore, redisHeldCounts } from './held-events.js';
export {
  ACCOUNTS_WITHDRAWN_TOPIC,
  kafkaConsumersFromEnv,
  PURCHASE_SESSIONS_TOPIC,
  QUEUE_GROUP,
  QUEUE_TOPICS,
  type QueueEvent,
  type QueueEventHandlers,
  QueueEventsHandler,
  type QueueKafkaConfig,
} from './queue-events.js';
