// 이의 건 요청을 거래·제어 Kafka 클러스터 support.cases-requested에 Outbox 없이 바로 낸다(asyncapi publishCaseRequested, docs/features/bot-defense.md §12, ADR-0259 결정 6).
// queue-svc의 첫 Kafka 생산자다(DB가 없다). 키는 sourceId(이의 ID), 값은 계약 모양(CaseRequested) 그대로의 JSON 바이트다(Avro 인코더 BAS-030 전, 텔레메트리와 같은 방식).
// 머리에는 지금 추적 문맥을 싣는다(바로 보내는 메시지, docs/observability.md §2). 이의 글은 싣지 않는다(ops-svc가 GetVerificationAppeal로 읽는다).
// 생산자는 처음 보낼 때 잇고, 연결에 실패하면 버리고 다음 보내기에서 새로 만든다. 보내기가 잇달아 3번 [가정] 실패해도 버리고 새로 만든다(ADR-0259 결정 12).
// 기다리는 상한(2초 [가정])은 부르는 쪽(SubmitAppeal)이 건다.
// 네이티브 모듈(@peaket/platform/stream-worker)은 시작 파일이 켤 때만 싣고 만드는 함수만 넘긴다(시험·Kafka 없는 환경은 모듈 없이 돈다).
import { CaseRequested } from '@peaket/contracts/asyncapi';
import type { CaseRequestPublisher } from '../domain/ports.js';
import type { CaseRequest } from '../domain/verification.js';

export const CASES_REQUESTED_TOPIC = 'support.cases-requested';
/** 생산자를 버리고 새로 만드는 잇단 보내기 실패 수 [가정] */
export const CASE_PRODUCER_MAX_SEND_FAILURES = 3;
/** 계약 CaseRequested.kind */
export const VERIFICATION_APPEAL_KIND = 'VERIFICATION_APPEAL';

/** 쓰는 생산자 면(@peaket/platform/stream-worker의 KafkaProducer가 맞는다) */
export interface CaseProducer {
  connect(): Promise<void>;
  send(r: { topic: string; messages: { key: string; value: Buffer; headers?: Record<string, string> }[] }): Promise<unknown>;
  disconnect(): Promise<void>;
}

/** 계약 모양 그대로의 값(JSON 바이트). 이의 글은 칸이 없다 */
export function caseRequestValue(c: CaseRequest): Buffer {
  const value = CaseRequested.parse({ eventKey: c.eventKey, kind: VERIFICATION_APPEAL_KIND, sourceId: c.sourceId, category: c.category, followUp: false, hold: false, createdAt: new Date(c.createdAtMs).toISOString() });
  return Buffer.from(JSON.stringify(value), 'utf8');
}

export class KafkaCaseRequests implements CaseRequestPublisher {
  #current: { producer: CaseProducer; ready: Promise<void> } | undefined;
  /** 지금 생산자의 잇단 보내기 실패 수(성공하면 0) */
  #sendFailures = 0;
  readonly #maxSendFailures: number;

  constructor(
    private readonly make: () => CaseProducer,
    private readonly traceHeaders: () => Record<string, string> = () => ({}),
    o: { maxSendFailures?: number } = {},
  ) {
    this.#maxSendFailures = o.maxSendFailures ?? CASE_PRODUCER_MAX_SEND_FAILURES;
  }

  #connected(): { producer: CaseProducer; ready: Promise<void> } {
    if (this.#current) return this.#current;
    const producer = this.make();
    const entry = {
      producer,
      ready: Promise.resolve()
        .then(() => producer.connect())
        .catch((err: unknown) => {
          // 이 객체로는 다시 잇지 못한다: 버리고 다음 보내기는 새 객체로 한다
          if (this.#current === entry) {
            this.#current = undefined;
            this.#sendFailures = 0;
          }
          void producer.disconnect().catch(() => undefined);
          throw err;
        }),
    };
    this.#current = entry;
    return entry;
  }

  /** 시작 때 미리 잇는다(첫 이의가 연결을 기다리지 않게). 실패해도 다음 보내기가 다시 잇는다 */
  warm(): void {
    this.#connected().ready.catch(() => undefined);
  }

  async publish(c: CaseRequest): Promise<void> {
    const value = caseRequestValue(c);
    const entry = this.#connected();
    await entry.ready;
    try {
      await entry.producer.send({ topic: CASES_REQUESTED_TOPIC, messages: [{ key: c.sourceId, value, headers: this.traceHeaders() }] });
    } catch (err) {
      // 잇달아 실패하는 생산자(끊긴 연결을 되잇지 못하는 객체)는 버리고 다음 보내기에서 새로 만든다
      if (this.#current === entry && ++this.#sendFailures >= this.#maxSendFailures) {
        this.#current = undefined;
        this.#sendFailures = 0;
        void entry.producer.disconnect().catch(() => undefined);
      }
      throw err;
    }
    if (this.#current === entry) this.#sendFailures = 0;
  }

  async close(): Promise<void> {
    const entry = this.#current;
    this.#current = undefined;
    if (entry) await entry.producer.disconnect().catch(() => undefined);
  }
}
