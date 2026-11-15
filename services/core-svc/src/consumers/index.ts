// core-svc Kafka 구독의 공개 면(W7-audit COV2-06, docs/streaming.md §2.6 'core-svc 소비자'). 네이티브 Kafka 모듈을 싣는 시작 함수는 start.ts에서 따로 가져온다
// (시험이 그것 없이 설정·보류 감싸기만 쓰게). 그룹 peaket.core-svc.<환경> 하나가 identity.accounts-withdrawn을 읽는다.
// 뼈대(W7-audit 시험 단계): 모양만 두었고 동작과 값은 구현 담당이 채운다.
import type { HeldEventStore, KafkaAuth } from '@peaket/platform';

/** 서비스 소비자 그룹 이름(`peaket.core-svc.${env}`). 뼈대: 구현 담당이 채운다 */
export const CORE_GROUP = (_env: string): string => {
  throw new Error('아직 없음');
};

/** 읽는 토픽 셋. 뼈대: 값은 구현 담당이 채운다(지금은 비어 있다) */
export const CORE_TOPICS = [] as unknown as readonly ['identity.accounts-withdrawn'];

export type CoreKafkaConfig = { enabled: false; warning: string } | { enabled: true; brokers: string[]; auth: KafkaAuth | undefined; env: string };

/**
 * PEAKET_KAFKA_BROKERS가 없거나 빈칸뿐이면 local·ci만 꺼진 설정, 그 밖(값 없음 포함)은 PlatformConfigError. 틀린 조각은 몇 번째인지만 알린다(queue-svc와 같은 규칙).
 * 뼈대: 구현 담당이 채운다
 */
export function kafkaConsumersFromEnv(_env: Record<string, string | undefined>): CoreKafkaConfig {
  throw new Error('아직 없음');
}

/**
 * 보류 포트 감싸기: identity.accounts-withdrawn의 값은 {eventKey, accountId, withdrawnAt} JSON으로 바꿔 넣고, 읽지 못한 값은 null로 넣는다. 다른 토픽은 그대로.
 * 뼈대: 구현 담당이 채운다
 */
export function pidFreeHeldEventStore(_inner: HeldEventStore): HeldEventStore {
  throw new Error('아직 없음');
}
