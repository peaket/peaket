// rt-pulse 심장 박동(docs/streaming.md §1·§3 2, OPS-160, F-04-1). 1초마다 텔레메트리 토픽 셋의 모든 파티션에 PipelinePulse를
// 파티션을 직접 지정해 넣는다. ops-rt가 rt.pulse에 싣고 ops-svc가 신선도와 파티션별 끊김을 잰다.
// - 실행 중에는 레지스트리를 부르지 않는다: schema-ids 설정의 ID로 Confluent 형식을 직접 만든다(docs/api/avro/README.md §3).
//   주제 이름은 `<토픽>-peaket.telemetry.PipelinePulse`(TopicRecordNameStrategy)
// - 파티션 수는 시작 때와 30초 [가정]마다 다시 묻는다(파티션을 늘려도 다시 띄우지 않게, 추천 적용 2026-11-23, F-04-1 계획)
// - 보내기가 실패해도 다음 박동을 계속 보낸다. 빠진 박동은 신선도가 나빠진 것으로 보인다(§1 '따로 감시하지 않는다')
import avsc from 'avsc';
import { encodeConfluent } from '@peaket/platform';

export const PULSE_TOPICS = ['telemetry.queue', 'telemetry.purchase', 'telemetry.trust-verdicts'] as const;
export const PULSE_RECORD = 'peaket.telemetry.PipelinePulse';
export const PULSE_INTERVAL_MS = 1_000;
export const PARTITION_REFRESH_MS = 30_000;

export const pulseSubject = (topic: string) => `${topic}-${PULSE_RECORD}`;

export interface PulseMessage {
  readonly topic: string;
  readonly partition: number;
  readonly value: Buffer;
}

export interface PulseTransport {
  /** 토픽의 파티션 번호 목록 */
  partitions(topic: string): Promise<number[]>;
  send(messages: readonly PulseMessage[]): Promise<void>;
}

/** PipelinePulse 값 하나(토픽·파티션·발행 시각)를 Confluent 형식으로 */
export function pulseEncoder(schema: unknown, schemaIds: Readonly<Record<string, number>>) {
  const type = avsc.Type.forSchema(schema as avsc.Schema);
  return (topic: string, partition: number, producedAtMs: number): Buffer => {
    const id = schemaIds[pulseSubject(topic)];
    if (id === undefined) throw new Error(`schema-ids에 ${pulseSubject(topic)}가 없다`);
    return encodeConfluent(id, type.toBuffer({ kind: 'PULSE', topic, partition, producedAt: producedAtMs }));
  };
}

export interface PulseEmitterOptions {
  readonly transport: PulseTransport;
  readonly encode: (topic: string, partition: number, producedAtMs: number) => Buffer;
  readonly now?: () => number;
  readonly topics?: readonly string[];
  readonly intervalMs?: number;
  readonly onError?: (err: unknown) => void;
}

export class PulseEmitter {
  readonly #o: PulseEmitterOptions;
  readonly #parts = new Map<string, number[]>();
  #refreshedAt = Number.NEGATIVE_INFINITY;
  #timer: NodeJS.Timeout | undefined;
  #busy = false;
  /** 시험·지표용: 보낸 박동 수 */
  sent = 0;

  constructor(o: PulseEmitterOptions) {
    this.#o = o;
  }

  /** 박동 한 번: 토픽마다 모든 파티션에 하나씩 */
  async beat(): Promise<number> {
    const now = (this.#o.now ?? Date.now)();
    const topics = this.#o.topics ?? PULSE_TOPICS;
    if (now - this.#refreshedAt >= PARTITION_REFRESH_MS || this.#parts.size === 0) {
      for (const t of topics) this.#parts.set(t, await this.#o.transport.partitions(t));
      this.#refreshedAt = now;
    }
    const messages = topics.flatMap((topic) => (this.#parts.get(topic) ?? []).map((partition) => ({ topic, partition, value: this.#o.encode(topic, partition, now) })));
    await this.#o.transport.send(messages);
    this.sent += messages.length;
    return messages.length;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#busy) return;
      this.#busy = true;
      this.beat()
        .catch((err: unknown) => this.#o.onError?.(err))
        .finally(() => {
          this.#busy = false;
        });
    }, this.#o.intervalMs ?? PULSE_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
