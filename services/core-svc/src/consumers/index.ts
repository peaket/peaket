// core-svc Kafka 구독의 공개 면(W7-audit COV2-06, docs/streaming.md §2.6 'core-svc 소비자'). 네이티브 Kafka 모듈을 싣는 시작 함수는 start.ts에서 따로 가져온다
// (시험이 그것 없이 설정·보류 감싸기만 쓰게). 그룹 peaket.core-svc.<환경> 하나가 identity.accounts-withdrawn을 읽는다.
import { type HeldEventInput, type HeldEventStore, type KafkaAuth, kafkaAuthFromEnv, PlatformConfigError } from '@peaket/platform';
import { ACCOUNTS_WITHDRAWN_TOPIC, readReviewWithdrawn } from '../modules/review/index.js';

/** 서비스 소비자 그룹 이름(docs/streaming.md §2.6) */
export const CORE_GROUP = (env: string): string => `peaket.core-svc.${env}`;

/** 읽는 토픽 셋(탈퇴 사건 하나) */
export const CORE_TOPICS = [ACCOUNTS_WITHDRAWN_TOPIC] as const satisfies readonly ['identity.accounts-withdrawn'];

/** 브로커 주소 모양(플랫폼 loadOutboxRelayProcessConfig의 BROKER와 같은 규칙, queue-svc와 같다) */
const BROKER = /^[A-Za-z0-9.-]+:\d{1,5}$/;
/** 브로커 주소 없이 떠도 되는 환경(플랫폼 kafkaAuthFromEnv가 평문을 허락하는 환경과 같다) */
const KAFKA_OPTIONAL_ENVS: readonly string[] = ['local', 'ci'];

export type CoreKafkaConfig = { enabled: false; warning: string } | { enabled: true; brokers: string[]; auth: KafkaAuth | undefined; env: string };

/**
 * PEAKET_KAFKA_BROKERS가 없거나 빈칸뿐이면 local·ci만 꺼진 설정, 그 밖(값 없음 포함)은 PlatformConfigError. 틀린 조각은 몇 번째인지만 알린다(queue-svc와 같은 규칙).
 * 운영에서 소비자 없이 뜨면 탈퇴한 계정의 후기가 조용히 파기되지 않는다(법정 파기 의무, docs/features/identity.md §8)
 * @throws PlatformConfigError 위의 시작 실패, kafkaAuthFromEnv의 오류
 */
export function kafkaConsumersFromEnv(env: Record<string, string | undefined>): CoreKafkaConfig {
  const raw = env.PEAKET_KAFKA_BROKERS?.trim();
  const peaketEnv = env.PEAKET_ENV;
  if (!raw) {
    if (peaketEnv !== undefined && KAFKA_OPTIONAL_ENVS.includes(peaketEnv)) {
      return { enabled: false, warning: `PEAKET_KAFKA_BROKERS가 없어 Kafka 소비자(탈퇴 사건의 후기 파기)를 켜지 않았다(PEAKET_ENV=${peaketEnv}에서만 허락한다)` };
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
