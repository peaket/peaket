// 홀드 시도를 asyncapi HoldAttempt(Avro)로 telemetry.purchase에 낸다(ADR-0357 결정 6·7·8, docs/features/seat-hold.md §3 '시도 하나의 내용', S-T35, A-T26 ②⑤, F-04-2).
// - record는 기다리지 않고 던지지 않는다. 응답 경로에 Redis 왕복을 더하지 않도록 시도 세기(hn)와 인코딩·버퍼 넣기는 뒤에서 한다
// - retryNo = 같은 구매 세션에서 그 시도 앞에 낸 시도의 수(세션 상태 키가 있을 때만 hn을 1 올린 값 − 1). 세기가 실패하거나 키가 없으면 버리고 센다.
//   계약을 채우지 못하는 시도는 세기 전에 버린다(버린 시도는 '낸 시도'가 아니다)
// - eventKey = 주입한 시계의 UUIDv7(시도 하나는 한 번만 기록되고 보내기가 실패하면 버린다, 결정 6)
// - 계약에 없는 칸(계정 ID)은 싣지 않는다. 만들지 못한 시도는 버리고 telemetry_dropped_total{record="HoldAttempt"}을 올리며,
//   경고 로그에는 레코드·칸 이름만 남긴다(계정·구매 세션·좌석 값은 싣지 않는다, ASVS 16.2.5)
// - Kafka 키는 구매 세션 ID다(docs/streaming.md §7, docs/api/avro/README.md §4. F-04-2 구현 메모)
import { AvroEncodeError, type AvroEncoder } from '@peaket/platform/avro';
import { type Clock, uuidv7 } from '@peaket/platform';
import type { HoldAttemptCounts, HoldAttemptRecord, HoldAttempts } from '../domain/ports.js';

/** 토픽 이름(asyncapi telemetry.purchase) */
export const TELEMETRY_PURCHASE_TOPIC = 'telemetry.purchase';
/** 레코드 전체 이름(docs/api/avro/peaket/telemetry/HoldAttempt.avsc) */
export const HOLD_ATTEMPT_RECORD = 'peaket.telemetry.HoldAttempt';
/** telemetry_dropped_total의 record 이름표 */
const DROPPED_RECORD = 'HoldAttempt';

export interface KafkaHoldAttemptsOptions {
  encoder: AvroEncoder;
  /** 텔레메트리 버퍼(TelemetrySink.offer) */
  offer: (record: string, topic: string, message: { key: string | null; value: Buffer }) => void;
  /** telemetry_dropped_total{record}을 올린다 */
  dropped: (record: string, count: number) => void;
  logger: { warn(obj: object, msg?: string): void };
  /** 시도 세기(좌석 Redis의 구매 세션 상태) */
  sessions: HoldAttemptCounts;
  clock: Clock;
  /** 뒤에서 하는 일을 맡긴다(종료 때 기다리려고 start.ts가 넘긴다). 주지 않으면 그냥 돌린다 */
  after?: (work: () => Promise<void>) => void;
}

/** 시도 하나를 asyncapi HoldAttempt 모양으로 옮긴다(날짜·시각은 ISO 글, 인코더가 밀리초로 바꾼다). 계정 ID는 옮기지 않는다 */
export function holdAttemptMessage(a: HoldAttemptRecord, retryNo: number, eventKey: string): Record<string, unknown> {
  return {
    eventId: a.eventId,
    purchaseSessionId: a.purchaseSessionId,
    journeyId: a.journeyId,
    mode: a.mode,
    ...(a.tierId !== undefined ? { tierId: a.tierId } : {}),
    ...(a.sectionId !== undefined ? { sectionId: a.sectionId } : {}),
    // 직접 선택은 요청한 좌석 모두, 자동 배정은 잡았을 때만 잡은 좌석(asyncapi seatIds)
    ...(a.mode === 'PICK' || a.result === 'HELD' ? { seatIds: [...a.seatIds] } : {}),
    result: a.result,
    ...(a.autoResult !== undefined ? { autoResult: a.autoResult } : {}),
    ...(a.heldAtMs !== undefined ? { heldAt: new Date(a.heldAtMs).toISOString() } : {}),
    firstHeldInSession: a.firstHeldInSession === true,
    retryNo,
    latencyMs: a.latencyMs,
    occurredAt: new Date(a.occurredAtMs).toISOString(),
    eventKey,
  };
}

export class KafkaHoldAttempts implements HoldAttempts {
  constructor(private readonly o: KafkaHoldAttemptsOptions) {}

  record(a: HoldAttemptRecord): void {
    // 값은 부른 뒤 바뀌지 않게 지금 옮겨 둔다
    const copy: HoldAttemptRecord = { ...a, seatIds: [...a.seatIds] };
    const work = () => this.#send(copy).catch(() => this.#drop({ reason: 'unexpected' }));
    if (this.o.after) this.o.after(work);
    else void work();
  }

  #drop(fields: object): void {
    this.o.dropped(DROPPED_RECORD, 1);
    this.o.logger.warn({ kind: 'telemetry-dropped', record: DROPPED_RECORD, ...fields }, '홀드 시도를 내지 못해 버린다');
  }

  async #send(a: HoldAttemptRecord): Promise<void> {
    const eventKey = uuidv7(this.o.clock);
    // 계약을 채우지 못하는 시도는 세기 전에 버린다(버린 시도가 다음 시도의 retryNo를 올리지 않게)
    try {
      this.o.encoder.encode(TELEMETRY_PURCHASE_TOPIC, HOLD_ATTEMPT_RECORD, holdAttemptMessage(a, 0, eventKey));
    } catch (err) {
      this.#drop(err instanceof AvroEncodeError ? { reason: 'encode-failed', fields: [...err.fields] } : { reason: 'encode-failed' });
      return;
    }
    let retryNo: number | null;
    try {
      retryNo = await this.o.sessions.countHoldAttempt(a.purchaseSessionId);
    } catch {
      this.#drop({ reason: 'retry-count-failed' });
      return;
    }
    if (retryNo === null) {
      this.#drop({ reason: 'session-gone' });
      return;
    }
    let value: Buffer;
    try {
      value = this.o.encoder.encode(TELEMETRY_PURCHASE_TOPIC, HOLD_ATTEMPT_RECORD, holdAttemptMessage(a, retryNo, eventKey));
    } catch (err) {
      this.#drop(err instanceof AvroEncodeError ? { reason: 'encode-failed', fields: [...err.fields] } : { reason: 'encode-failed' });
      return;
    }
    this.o.offer(DROPPED_RECORD, TELEMETRY_PURCHASE_TOPIC, { key: a.purchaseSessionId, value });
  }
}
