// 판정 기록·행동 신호 바이트를 시험 안에서 푸는 도구(F-04-2, ADR-0357 결정 3·9). 기록기는 공용 Avro 인코더로 Confluent 형식 바이트를 내고,
// 이 도구는 제품 인코더를 거치지 않고 packages/platform/test/produced-avro.ts(avsc + 계약 판 .avsc)로 풀어 공통 판정 ①②③(A-T26)을 본 뒤
// asyncapi 모양(null 칸 없음, 시각은 ISO 글)으로 되돌린다. 그래서 옛 JSON 대역 시험의 단언(계약 Zod·칸 이름)을 같은 강도로 쓸 수 있다.
// 스키마 ID는 코드 상수와 겹치지 않게 55·66으로 고른다.
import { avroSchemas } from '@peaket/contracts/avro';
import { type AvroEncoder, createAvroEncoder } from '@peaket/platform/avro';
import { decodeProduced } from '../../../packages/platform/test/produced-avro.js';

export const TELEMETRY_SCHEMA_IDS = {
  'telemetry.trust-verdicts-peaket.telemetry.TrustVerdict': 55,
  'telemetry.behavior-peaket.telemetry.BehaviorSignal': 66,
} as const;

const RECORDS = { TrustVerdict: 'peaket.telemetry.TrustVerdict', BehaviorSignal: 'peaket.telemetry.BehaviorSignal' } as const;
const TOPICS = { TrustVerdict: 'telemetry.trust-verdicts', BehaviorSignal: 'telemetry.behavior' } as const;
/** timestamp-millis 칸(asyncapi는 date-time 글) */
const TIME_FIELDS = new Set(['occurredAt', 'ts']);

/** trust-svc 운영 조립과 같은 두 주제를 내는 인코더 */
export function telemetryEncoder(): AvroEncoder {
  return createAvroEncoder({
    schemaIds: TELEMETRY_SCHEMA_IDS,
    schemas: avroSchemas,
    produces: [
      { topic: TOPICS.TrustVerdict, record: RECORDS.TrustVerdict },
      { topic: TOPICS.BehaviorSignal, record: RECORDS.BehaviorSignal },
    ],
  });
}

/** 계약 판으로 푼 값(null 그대로). 머리 ID가 그 주제의 설정 값이 아니거나 공통 판정 ②③을 어기면 던진다 */
export function decodedTelemetry(record: string, bytes: Uint8Array): Record<string, unknown> {
  if (record !== 'TrustVerdict' && record !== 'BehaviorSignal') throw new Error(`모르는 기록: ${record}`);
  const p = decodeProduced(bytes, RECORDS[record]);
  const want = (TELEMETRY_SCHEMA_IDS as Readonly<Record<string, number>>)[`${TOPICS[record]}-${RECORDS[record]}`];
  if (p.schemaId !== want) throw new Error(`${record} 스키마 ID가 ${want}가 아니라 ${p.schemaId}다`);
  if (p.violations.length > 0) throw new Error(`${record} 공통 판정 위반: ${p.violations.join(', ')}`);
  return p.value;
}

/** 푼 값을 asyncapi 모양으로(null 칸을 걷고 시각은 ISO 글로) */
export function asyncapiTelemetry(record: string, bytes: Uint8Array): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decodedTelemetry(record, bytes))) {
    if (v === null) continue;
    if (TIME_FIELDS.has(k)) out[k] = new Date(v as number).toISOString();
    else if (k === 'features') out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null));
    else out[k] = v;
  }
  return out;
}
