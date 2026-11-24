// core-svc Kafka 구독의 공개 면(W7-audit COV2-06, docs/streaming.md §2.6 'core-svc 소비자'). 네이티브 Kafka 모듈을 싣는 시작 함수는 start.ts에서 따로 가져온다
// (시험이 그것 없이 설정·보류 감싸기만 쓰게). 그룹 peaket.core-svc.<환경> 하나가 identity.accounts-withdrawn과 identity.accounts-merged를 읽는다.
// 토픽 하나에 처리기가 여럿이므로(CORE_TOPICS가 늘었다, F-05-8) 토픽으로 갈라 부르는 합성 처리기를 둔다.
import { type ConsumedMessage, type HeldEventInput, type HeldEventStore, type KafkaAuth, kafkaAuthFromEnv, type KeyedHandler, PlatformConfigError } from '@peaket/platform';
import { CATALOG_ACCOUNTS_MERGED_TOPIC, type CatalogAccountMergedHandler, type CatalogMergedEvent } from '../modules/catalog/index.js';
import { ACCOUNTS_WITHDRAWN_TOPIC, type ReviewAccountWithdrawnHandler, type ReviewWithdrawnEvent, readReviewWithdrawn } from '../modules/review/index.js';
import type { CatalogAccountWithdrawnHandler, CatalogWithdrawnEvent } from '../modules/catalog/index.js';

export { CATALOG_ACCOUNTS_MERGED_TOPIC, ACCOUNTS_WITHDRAWN_TOPIC };

/** 서비스 소비자 그룹 이름(docs/streaming.md §2.6) */
export const CORE_GROUP = (env: string): string => `peaket.core-svc.${env}`;

/** 지금 읽는 토픽(탈퇴 사건). 합성 처리기를 쓸 때는 CORE_ALL_TOPICS를 읽는다 */
export const CORE_TOPICS = [ACCOUNTS_WITHDRAWN_TOPIC] as const satisfies readonly ['identity.accounts-withdrawn'];

/** 탈퇴·계정 병합 두 토픽(F-05-8 합성 처리기) */
export const CORE_ALL_TOPICS = [ACCOUNTS_WITHDRAWN_TOPIC, CATALOG_ACCOUNTS_MERGED_TOPIC] as const satisfies readonly ['identity.accounts-withdrawn', 'identity.accounts-merged'];

/** 브로커 주소 모양(플랫폼 loadOutboxRelayProcessConfig의 BROKER와 같은 규칙, queue-svc와 같다) */
const BROKER = /^[A-Za-z0-9.-]+:\d{1,5}$/;
/** 브로커 주소 없이 떠도 되는 환경(플랫폼 kafkaAuthFromEnv가 평문을 허락하는 환경과 같다) */
const KAFKA_OPTIONAL_ENVS: readonly string[] = ['local', 'ci'];

export type CoreKafkaConfig = { enabled: false; warning: string } | { enabled: true; brokers: string[]; auth: KafkaAuth | undefined; env: string };

/**
 * PEAKET_KAFKA_BROKERS가 없거나 빈칸뿐이면 local·ci만 꺼진 설정, 그 밖(값 없음 포함)은 PlatformConfigError. 틀린 조각은 몇 번째인지만 알린다(queue-svc와 같은 규칙).
 * 운영에서 소비자 없이 뜨면 탈퇴한 계정의 후기·찜이 조용히 파기되지 않는다(법정 파기 의무, docs/features/identity.md §8)
 * @throws PlatformConfigError 위의 시작 실패, kafkaAuthFromEnv의 오류
 */
export function kafkaConsumersFromEnv(env: Record<string, string | undefined>): CoreKafkaConfig {
  const raw = env.PEAKET_KAFKA_BROKERS?.trim();
  const peaketEnv = env.PEAKET_ENV;
  if (!raw) {
    if (peaketEnv !== undefined && KAFKA_OPTIONAL_ENVS.includes(peaketEnv)) {
      return { enabled: false, warning: `PEAKET_KAFKA_BROKERS가 없어 Kafka 소비자(탈퇴 사건의 후기·찜 파기)를 켜지 않았다(PEAKET_ENV=${peaketEnv}에서만 허락한다)` };
    }
    throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS가 없다(PEAKET_ENV=${peaketEnv || '(없음)'}에서는 Kafka 소비자가 있어야 한다. local·ci만 없이 뜬다)`);
  }
  // 틀린 조각은 값 대신 몇 번째인지만 알린다(주소에 사용자 이름 등이 섞여 들 수 있다)
  const pieces = raw.split(',').map((s) => s.trim());
  const brokers = pieces.filter(Boolean);
  const bad = pieces.findIndex((s) => s !== '' && !BROKER.test(s));
  if (bad >= 0) throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS는 쉼표로 나눈 '호스트:포트' 목록이어야 한다: ${bad + 1}번째 조각이 그 모양이 아니다`);
  if (brokers.length === 0) throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS는 쉼표로 나눈 '호스트:포트' 목록이어야 한다: 빈 조각뿐이다`);
  if (!peaketEnv) throw new PlatformConfigError('PEAKET_ENV가 없어 Kafka 소비자 그룹 이름과 인증을 고를 수 없다');
  return { enabled: true, brokers, auth: kafkaAuthFromEnv('core-svc', env), env: peaketEnv };
}

/** 탈퇴 사건 값에서 pid·purgeBy를 뺀 JSON. 읽지 못하면 값 없이(null) 둔다(값 조각이 남지 않게) */
function pidFreeValue(value: Buffer | null): Buffer | null {
  if (value === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value.toString('utf8'));
  } catch {
    return null;
  }
  const e = readReviewWithdrawn(raw);
  return e ? Buffer.from(JSON.stringify({ eventKey: e.eventKey, accountId: e.accountId, withdrawnAt: e.withdrawnAt }), 'utf8') : null;
}

/**
 * 보류 포트 감싸기: identity.accounts-withdrawn의 값은 {eventKey, accountId, withdrawnAt} JSON으로 바꿔 넣고, 읽지 못한 값은 null로 넣는다. 다른 토픽은 그대로.
 * core DB에 pid 사본을 남기지 않는다(docs/security/data-classification.md '탈퇴 사건의 pid 사본'). 읽기는 안쪽 저장소의 것을 그대로 준다
 */
export function pidFreeHeldEventStore(inner: HeldEventStore): HeldEventStore {
  const strip = (e: HeldEventInput): HeldEventInput => (e.topic === ACCOUNTS_WITHDRAWN_TOPIC ? { ...e, value: pidFreeValue(e.value) } : e);
  return {
    heldKeys: (topic, partition) => inner.heldKeys(topic, partition),
    isHeld: (topic, businessKey) => inner.isHeld(topic, businessKey),
    hold: (e) => inner.hold(strip(e)),
    holdIfHeld: (e) => inner.holdIfHeld(strip(e)),
  };
}

/** 한 사건이 두 처리기(후기·찜)를 부른다. 처리기 하나가 실패하면 그 사건은 보류되고 다음에 둘 다 다시 불린다(둘 다 멱등) */
export type CoreAccountEvent =
  | { kind: 'withdrawn'; review: ReviewWithdrawnEvent; catalog: CatalogWithdrawnEvent }
  | { kind: 'merged'; merged: CatalogMergedEvent };

/**
 * 토픽으로 갈라 부르는 합성 처리기. decode는 토픽을 보고, handle은 종류를 보고 부른다.
 * keyOf는 업무 키(탈퇴·흡수 계정 ID), eventKeyOf는 중복 제거 키(eventKey·mergeId)다.
 */
export class CoreAccountEventHandler implements KeyedHandler<CoreAccountEvent> {
  constructor(
    private readonly reviews: Pick<ReviewAccountWithdrawnHandler, 'decode' | 'handle'>,
    private readonly wishWithdrawn: Pick<CatalogAccountWithdrawnHandler, 'decode' | 'handle'>,
    private readonly wishMerged: Pick<CatalogAccountMergedHandler, 'decode' | 'handle'>,
  ) {}

  decode(m: ConsumedMessage): CoreAccountEvent {
    if (m.topic === CATALOG_ACCOUNTS_MERGED_TOPIC) return { kind: 'merged', merged: this.wishMerged.decode(m) };
    if (m.topic === ACCOUNTS_WITHDRAWN_TOPIC) return { kind: 'withdrawn', review: this.reviews.decode(m), catalog: this.wishWithdrawn.decode(m) };
    throw new Error(`core-svc가 읽지 않는 토픽이다: ${m.topic}`);
  }

  keyOf(e: CoreAccountEvent): string {
    return e.kind === 'withdrawn' ? e.catalog.accountId : e.merged.mergedAccountId;
  }

  eventKeyOf(e: CoreAccountEvent): string {
    return e.kind === 'withdrawn' ? e.catalog.eventKey : e.merged.mergeId;
  }

  async handle(e: CoreAccountEvent): Promise<void> {
    if (e.kind === 'merged') {
      await this.wishMerged.handle(e.merged);
      return;
    }
    // 후기와 찜은 서로 다른 표라 한 트랜잭션일 수 없다. 둘 다 멱등이라 한쪽이 실패하면 보류 뒤 둘 다 다시 부른다
    await this.reviews.handle(e.review);
    await this.wishWithdrawn.handle(e.catalog);
  }
}
