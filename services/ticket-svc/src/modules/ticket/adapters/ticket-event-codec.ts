// trade.tickets TicketEvent의 Confluent Avro 값(ADR-0357, docs/data.md §4, docs/api/avro/README.md §3).
// 스키마 ID는 운영 ConfigMap(schema-ids.json)을 읽고, 로컬·CI는 계약의 고정 ID(localSchemaIds)를 쓴다.
import { createAvroEncoder, readSchemaIdsFile, type AvroEncoder } from '@peaket/platform/avro';
import { avroSchemas, localSchemaIds } from '@peaket/contracts/avro';
import { TRANSFER_EVENT_TOPIC, type TransferEventCodec } from '../domain/transfer-events.js';

export const TICKET_EVENT_RECORD = 'peaket.trade.TicketEvent';

/** 공용 Avro 인코더를 Outbox 코덱으로 감싼다. encode가 Confluent 매직 0+스키마 ID+Avro 바이트를 준다 */
export function ticketEventCodec(encoder: AvroEncoder): TransferEventCodec {
  return { encode: (message) => encoder.encode(TRANSFER_EVENT_TOPIC, TICKET_EVENT_RECORD, message) };
}

/** 환경값으로 TicketEvent Avro 코덱을 만든다. local·ci·demo는 계약의 고정 스키마 ID, 그 밖은 ConfigMap이 필수다 */
export function ticketEventCodecFromEnv(env: Record<string, string | undefined>): TransferEventCodec {
  const local = env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci' || env.PEAKET_ENV === 'demo';
  const schemaIds = local ? localSchemaIds : readSchemaIdsFile(env);
  return ticketEventCodec(createAvroEncoder({ schemaIds, schemas: avroSchemas, produces: [{ topic: TRANSFER_EVENT_TOPIC, record: TICKET_EVENT_RECORD }] }));
}
