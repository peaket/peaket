// 관제 1초 대기 집계 QueueAggregate(asyncapi telemetry.queue, docs/streaming.md §4.1·§4.2, F-04-20).
// 파드마다 회차별로 1초 칸의 진입·빠진 번호·입장 확정·곧 입장 응답 수를 세어, 끝난 칸을 1초마다 telemetry.queue에 낸다(키 '회차:파드').
// 관측은 업무 경로를 막지 않는다(감독 조건 2026-11-23): 세기는 동기 정수 더하기 하나이고 I/O가 없다. 인코딩·보내기는 1초 타이머에서만 하고,
// 보내기는 텔레메트리 버퍼(TelemetrySink.offer, 기다리지 않음·버퍼가 차면 버리고 telemetry_dropped_total)에 넣는다. 어떤 실패도 부른 쪽으로 던지지 않는다.
// eventKey는 (파드, 회차, 칸 시각)에서 정해진다: 같은 칸을 다시 보내면 같은 값이라 실시간 표가 중복을 지운다(asyncapi eventKey).
import { createHash } from 'node:crypto';

export const TELEMETRY_QUEUE_TOPIC = 'telemetry.queue';
export const QUEUE_AGGREGATE_RECORD = 'peaket.telemetry.QueueAggregate';
/** 칸 길이 1초(계약 second) */
const SECOND_MS = 1_000;
/** 들고 있는 칸 상한(회차 × 칸). 보내기가 오래 멈춰도 메모리가 끝없이 늘지 않게 [가정] */
const MAX_BUCKETS = 10_000;

interface Bucket {
  entries: number;
  removed: number;
  admissions: number;
  soon: number;
}

export interface QueueAggregateOptions {
  /** 파드 이름(메시지 키 '회차:파드'의 뒤, ADR-0146 결정 8) */
  readonly pod: string;
  /** 계약 판 인코더(@peaket/platform/avro createAvroEncoder) */
  readonly encode: (message: Record<string, unknown>) => Buffer;
  /** 텔레메트리 버퍼에 넣는다(기다리지 않는다) */
  readonly offer: (topic: string, message: { key: string; value: Buffer }) => void;
  readonly now: () => number;
  /** 내지 못한 칸 수(인코딩 실패·칸 상한) */
  readonly dropped?: (count: number) => void;
  readonly intervalMs?: number;
}

/** (파드, 회차, 칸 시각) → UUID 꼴(SHA-256 앞 16바이트, 판 8·변형 RFC 9562) */
export function aggregateEventKey(pod: string, eventId: string, secondMs: number): string {
  const h = createHash('sha256').update(`QueueAggregate:${pod}:${eventId}:${secondMs}`, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * entry 모듈 QueueCounts(entered·removed)와 admission 모듈 AdmissionCounts(admitted·soon·removed)를 함께 구현한다.
 * 세기 메서드는 던지지 않는다
 */
export class QueueAggregator {
  readonly #buckets = new Map<string, Bucket>();
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly o: QueueAggregateOptions) {}

  entered(eventId: string): void {
    this.#add(eventId, 'entries');
  }
  removed(eventId: string): void {
    this.#add(eventId, 'removed');
  }
  admitted(eventId: string): void {
    this.#add(eventId, 'admissions');
  }
  soon(eventId: string): void {
    this.#add(eventId, 'soon');
  }

  #add(eventId: string, field: keyof Bucket): void {
    try {
      const second = Math.floor(this.o.now() / SECOND_MS) * SECOND_MS;
      const k = `${second}\u0000${eventId}`;
      let b = this.#buckets.get(k);
      if (!b) {
        if (this.#buckets.size >= MAX_BUCKETS) {
          this.o.dropped?.(1);
          return;
        }
        b = { entries: 0, removed: 0, admissions: 0, soon: 0 };
        this.#buckets.set(k, b);
      }
      b[field] += 1;
    } catch {
      // 관측은 업무 경로를 막지 않는다
    }
  }

  /** 끝난 칸(지금 칸보다 앞)을 모두 낸다. 시험은 직접 부른다 */
  flush(nowMs: number = this.o.now(), all = false): number {
    const current = Math.floor(nowMs / SECOND_MS) * SECOND_MS;
    let sent = 0;
    for (const [k, b] of this.#buckets) {
      const sep = k.indexOf('\u0000');
      const second = Number(k.slice(0, sep));
      if (!all && second >= current) continue;
      this.#buckets.delete(k);
      const eventId = k.slice(sep + 1);
      try {
        const value = this.o.encode({
          eventId,
          second: new Date(second).toISOString(),
          entries: b.entries,
          removed: b.removed,
          admissions: b.admissions,
          soonResponses: b.soon,
          eventKey: aggregateEventKey(this.o.pod, eventId, second),
        });
        this.o.offer(TELEMETRY_QUEUE_TOPIC, { key: `${eventId}:${this.o.pod}`, value });
        sent += 1;
      } catch {
        this.o.dropped?.(1);
      }
    }
    return sent;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.flush(), this.o.intervalMs ?? SECOND_MS);
    this.#timer.unref();
  }

  /** 멈추고 남은 칸을 모두 낸다(종료 때 텔레메트리 버퍼를 닫기 전에) */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.flush(this.o.now(), true);
  }
}
