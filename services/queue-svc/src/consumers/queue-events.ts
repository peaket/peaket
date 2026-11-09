// queue-svc Kafka 구독의 처리기와 설정(docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', docs/streaming.md §2.6, ADR-0214 결정 1).
// 모든 파드가 서비스 소비자 그룹 하나(peaket.queue-svc.<환경>)로 토픽 셋을 키 단위로 읽는다. 처리기 하나가 토픽으로 나눠 맡긴다
// (토픽마다 그룹을 두면 T=0에 크게 느는 파드 수의 세 배만큼 브로커 연결이 는다). 이 파일은 Kafka 클라이언트(네이티브 모듈)를 싣지 않는다(start.ts가 싣는다).
import { type ConsumedMessage, type KafkaAuth, kafkaAuthFromEnv, type KeyedHandler, PlatformConfigError } from '@peaket/platform';
import { ACCOUNTS_WITHDRAWN_TOPIC } from '../modules/entry/index.js';
import { SEATS_TOPIC } from '../modules/sale/index.js';

export { ACCOUNTS_WITHDRAWN_TOPIC };
export const PURCHASE_SESSIONS_TOPIC = 'trade.purchase-sessions';
/** 읽는 토픽 셋(구매 세션 사건, 탈퇴 사건, 회차 판매 상태가 실린 trade.seats) */
export const QUEUE_TOPICS: readonly string[] = [PURCHASE_SESSIONS_TOPIC, ACCOUNTS_WITHDRAWN_TOPIC, SEATS_TOPIC];
/** 서비스 소비자 그룹 이름(docs/streaming.md §2.6) */
export const QUEUE_GROUP = (env: string): string => `peaket.queue-svc.${env}`;

/** 토픽마다의 처리기 */
export interface QueueEventHandlers {
  purchaseSessions: KeyedHandler<unknown>;
  accountsWithdrawn: KeyedHandler<unknown>;
  saleChanged: KeyedHandler<unknown>;
}

/** 읽은 값: 그 토픽 처리기의 값, 또는 모르는 토픽 */
export type QueueEvent = { topic: string; event: unknown } | { topic: string; unknown: true; key: string };

/** 토픽으로 나눠 맡기는 처리기. 업무 키는 토픽 처리기의 것이다(키 단위 소비자의 파티션은 토픽마다 따로라 키가 섞이지 않는다) */
export class QueueEventsHandler implements KeyedHandler<QueueEvent> {
  readonly #byTopic: Map<string, KeyedHandler<unknown>>;

  constructor(h: QueueEventHandlers) {
    this.#byTopic = new Map<string, KeyedHandler<unknown>>([
      [PURCHASE_SESSIONS_TOPIC, h.purchaseSessions],
      [ACCOUNTS_WITHDRAWN_TOPIC, h.accountsWithdrawn],
      [SEATS_TOPIC, h.saleChanged],
    ]);
  }

  async decode(m: ConsumedMessage): Promise<QueueEvent> {
    const h = this.#byTopic.get(m.topic);
    if (!h) return { topic: m.topic, unknown: true, key: `bad:${m.topic}:${m.key ?? ''}` };
    return { topic: m.topic, event: await h.decode(m) };
  }

  keyOf(e: QueueEvent, m: ConsumedMessage): string {
    if ('unknown' in e) return e.key;
    return this.#byTopic.get(e.topic)!.keyOf(e.event, m);
  }

  eventKeyOf(e: QueueEvent): string | undefined {
    if ('unknown' in e) return undefined;
    return this.#byTopic.get(e.topic)!.eventKeyOf?.(e.event);
  }

  /** @throws RangeError 모르는 토픽(키 단위 소비자가 보류한다). 그 밖은 토픽 처리기의 것 */
  async handle(e: QueueEvent, m: ConsumedMessage): Promise<void> {
    if ('unknown' in e) throw new RangeError(`queue-svc가 읽지 않는 토픽이다: ${e.topic}`);
    await this.#byTopic.get(e.topic)!.handle(e.event, m);
  }
}

/** 브로커 주소 모양(플랫폼 loadOutboxRelayProcessConfig의 BROKER와 같은 규칙) */
const BROKER = /^[A-Za-z0-9.-]+:\d{1,5}$/;
/** 브로커 주소 없이 떠도 되는 환경(플랫폼 kafkaAuthFromEnv가 평문을 허락하는 환경과 같다) */
const KAFKA_OPTIONAL_ENVS: readonly string[] = ['local', 'ci'];

export type QueueKafkaConfig = { enabled: false; warning: string } | { enabled: true; brokers: string[]; auth: KafkaAuth | undefined; env: string };

/**
 * 소비자 설정을 환경 값에서 읽는다(purchase-svc kafkaConsumersFromEnv와 같은 규칙).
 * PEAKET_KAFKA_BROKERS가 없거나 빈칸뿐이면 local·ci만 꺼진 설정이고, 그 밖의 환경(값 없음 포함)은 던진다(시작 실패). 있으면 쉼표로 나눈 '호스트:포트'여야 하고,
 * 틀린 조각은 값 대신 몇 번째인지만 알린다(주소에 사용자 이름 등이 섞여 들 수 있다)
 * @throws PlatformConfigError 위의 시작 실패, kafkaAuthFromEnv의 오류
 */
export function kafkaConsumersFromEnv(env: Record<string, string | undefined>): QueueKafkaConfig {
  const raw = env.PEAKET_KAFKA_BROKERS?.trim();
  const peaketEnv = env.PEAKET_ENV;
  if (!raw) {
    if (peaketEnv !== undefined && KAFKA_OPTIONAL_ENVS.includes(peaketEnv)) {
      return { enabled: false, warning: `PEAKET_KAFKA_BROKERS가 없어 Kafka 소비자(구매 세션·탈퇴·회차 판매 상태)를 켜지 않았다(PEAKET_ENV=${peaketEnv}에서만 허락한다)` };
    }
    // 조용히 소비자 없이 뜨지 않는다: 매진이 대기열에 반영되지 않고 구매 세션 자리가 비지 않는다
    throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS가 없다(PEAKET_ENV=${peaketEnv || '(없음)'}에서는 Kafka 소비자가 있어야 한다. local·ci만 없이 뜬다)`);
  }
  const pieces = raw.split(',').map((s) => s.trim());
  const brokers = pieces.filter(Boolean);
  const bad = pieces.findIndex((s) => s !== '' && !BROKER.test(s));
  if (bad >= 0) throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS는 쉼표로 나눈 '호스트:포트' 목록이어야 한다: ${bad + 1}번째 조각이 그 모양이 아니다`);
  if (brokers.length === 0) throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS는 쉼표로 나눈 '호스트:포트' 목록이어야 한다: 빈 조각뿐이다`);
  if (!peaketEnv) throw new PlatformConfigError('PEAKET_ENV가 없어 Kafka 소비자 그룹 이름과 인증을 고를 수 없다');
  return { enabled: true, brokers, auth: kafkaAuthFromEnv('queue-svc', env), env: peaketEnv };
}
