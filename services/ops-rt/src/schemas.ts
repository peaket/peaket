// 작업자가 빌드된 계약 판의 읽기 스키마(docs/api/avro/peaket, ADR-0165). 이미지에는 그 폴더를 함께 싣는다.
// 같은 토픽에 실리는 다른 레코드(EventSaleChanged·QueueEntryRecord)도 읽기 스키마에 넣는다: 그래야 그 레코드의 모르는 열거 기호도
// 바르게 UNRECOGNIZED로 읽고(§2.6), 행으로 바꿀 때 건너뛴다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** ops-rt가 읽는 토픽 일곱에 실리는 레코드 */
export const OPS_RT_RECORDS = [
  'trade/SeatEvent',
  'trade/EventSaleChanged',
  'trade/OrderEvent',
  'trade/PaymentEvent',
  'trade/TicketEvent',
  'telemetry/QueueAggregate',
  'telemetry/QueueEntryRecord',
  'telemetry/PipelinePulse',
  'telemetry/HoldAttempt',
  'telemetry/TrustVerdict',
] as const;

export function loadReaderSchemas(avroDir: string, names: readonly string[] = OPS_RT_RECORDS): unknown[] {
  return names.map((n) => JSON.parse(readFileSync(join(avroDir, 'peaket', `${n}.avsc`), 'utf8')) as unknown);
}
