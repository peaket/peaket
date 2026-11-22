// @peaket/platform/avro: 사건을 내는 서비스의 공용 Avro 인코더(ADR-0357 결정 1, docs/api/avro/README.md §3 '생산자 스키마 ID', F-04-2).
// Kafka 네이티브 모듈을 싣지 않고 avsc만 싣는다. Outbox만 쓰는 API 파드(Kafka 연결이 없다)도 이 내보내기로 바이트를 만든다.
// 뿌리 내보내기(@peaket/platform)는 이 파일을 다시 내보내지 않는다(Avro를 쓰지 않는 서비스가 avsc를 싣지 않게, docs/devops.md §4.4).
export { AvroEncodeError, createAvroEncoder, subjectOf, type AvroEncoder, type AvroEncoderOptions } from './avro-encoder.js';
export {
  checkProducerSchemas,
  readSchemaIdsFile,
  sameJson,
  SCHEMA_IDS_FILE_ENV,
  SCHEMA_IDS_MOUNT_DIR,
  SCHEMA_REGISTRY_PASSWORD_ENV,
  SCHEMA_REGISTRY_URL_ENV,
  SCHEMA_REGISTRY_USER_ENV,
  SCHEMA_STARTUP_CHECK_GAUGE,
  type CheckProducerSchemasOptions,
  type ProducerSchemaCheckResult,
} from './producer-schemas.js';
export { CONFLUENT_MAGIC_BYTE, decodeConfluent, encodeConfluent } from './avro.js';
export { SchemaUnavailableError, UnknownSchemaError, type SchemaSource } from './avro-reader.js';
export { SCHEMA_REGISTRY_DEFAULTS, schemaRegistrySource, type SchemaRegistrySourceOptions } from './schema-registry-source.js';
