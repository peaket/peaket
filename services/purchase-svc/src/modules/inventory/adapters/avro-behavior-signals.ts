// 좌석·결제 화면의 행동 신호를 asyncapi BehaviorSignal 모양으로 낸다(토픽 telemetry.behavior, 키 pid, docs/features/bot-defense.md §4.1, ADR-0249 결정 4·6).
// 값은 공용 Avro 인코더로 만든 Confluent 형식 바이트다(ADR-0357 결정 3·9, F-04-2). purchase-svc는 요청 IP의 망 정보를 모르고 기기 가명을 계산하지 않아 netClass·asn·deviceRef를 싣지 않는다.
// 만들지 못한 기록은 버리고 telemetry_dropped_total{record="BehaviorSignal"}을 올리며, 경고 로그에는 레코드·칸 이름만 남긴다(ADR-0357 결정 8).
import { AvroEncodeError, type AvroEncoder } from '@peaket/platform/avro';
import type { BehaviorSignalRecord, BehaviorSignals } from '../domain/ports.js';

export const BEHAVIOR_TOPIC = 'telemetry.behavior';
/** 레코드 전체 이름(docs/api/avro/peaket/telemetry/BehaviorSignal.avsc) */
export const BEHAVIOR_SIGNAL_RECORD = 'peaket.telemetry.BehaviorSignal';

export interface TelemetryOut {
  offer(record: string, topic: string, message: { key: string | null; value: Buffer }): void;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** 요약 칸의 최댓값 [가정](ADR-0249 결정 7). 계약에 넣으면 깨지는 변경이라 받기는 하고 내보낼 때 뺀다. v·windowMs는 경로 스키마가 이미 막는다 */
const FEATURE_MAX: Readonly<Record<string, number>> = { v: 1, windowMs: 3_600_000, pointerMoves: 1_000_000, pointerEntropy: 3, inputIntervalMeanMs: 3_600_000, inputIntervalStdMs: 3_600_000, scrollEvents: 1_000_000, scrollDistancePx: 1_000_000_000 };

/** 계약의 칸만 옮긴다(브라우저 값을 그대로 다시 내보내지 않는다). 최댓값을 넘는 칸은 뺀다 */
function featuresOf(f: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, max] of Object.entries(FEATURE_MAX)) {
    const n = num(f[k]);
    if (n !== undefined && n <= max) out[k] = n;
  }
  return out;
}

export interface AvroBehaviorSignalsOptions {
  /** 텔레메트리 버퍼(TelemetrySink.offer) */
  offer: TelemetryOut['offer'];
  encoder: AvroEncoder;
  /** telemetry_dropped_total{record}을 올린다 */
  dropped: (record: string, count: number) => void;
  logger: { warn(obj: object, msg?: string): void };
}

export class AvroBehaviorSignals implements BehaviorSignals {
  constructor(private readonly o: AvroBehaviorSignalsOptions) {}

  record(r: BehaviorSignalRecord): void {
    const value = {
      pid: r.pid,
      refMissing: false,
      eventId: r.eventId,
      journeyId: r.journeyId,
      screen: r.screen,
      features: featuresOf(r.features),
      ts: new Date(r.tsMs).toISOString(),
      eventKey: r.eventKey,
    };
    let bytes: Buffer;
    try {
      bytes = this.o.encoder.encode(BEHAVIOR_TOPIC, BEHAVIOR_SIGNAL_RECORD, value);
    } catch (err) {
      this.o.dropped('BehaviorSignal', 1);
      this.o.logger.warn({ kind: 'telemetry-encode-failed', record: 'BehaviorSignal', ...(err instanceof AvroEncodeError ? { fields: [...err.fields] } : {}) }, '좌석 행동 요약을 Avro로 만들지 못해 버린다');
      return;
    }
    this.o.offer('BehaviorSignal', BEHAVIOR_TOPIC, { key: r.pid, value: bytes });
  }
}
