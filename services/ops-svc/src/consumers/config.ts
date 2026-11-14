// ops-svc Kafka 소비자 설정(docs/streaming.md §2.6). queue-svc kafkaConsumersFromEnv와 같은 규칙이다.
// PEAKET_KAFKA_BROKERS가 없으면 local·ci만 소비자를 끄고, 그 밖의 환경(값 없음 포함)은 시작하지 않는다(명령 사건을 잃지 않게).
import { type KafkaAuth, kafkaAuthFromEnv, PlatformConfigError } from '@peaket/platform';

/** 브로커 주소 모양(플랫폼 loadOutboxRelayProcessConfig의 BROKER와 같은 규칙) */
const BROKER = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const KAFKA_OPTIONAL_ENVS: readonly string[] = ['local', 'ci'];

export type OpsKafkaConfig = { enabled: false; warning: string } | { enabled: true; brokers: string[]; auth: KafkaAuth | undefined; env: string };

export function kafkaConsumersFromEnv(env: Record<string, string | undefined>): OpsKafkaConfig {
  const raw = env.PEAKET_KAFKA_BROKERS?.trim();
  const peaketEnv = env.PEAKET_ENV;
  if (!raw) {
    if (peaketEnv !== undefined && KAFKA_OPTIONAL_ENVS.includes(peaketEnv)) {
      return { enabled: false, warning: `PEAKET_KAFKA_BROKERS가 없어 Kafka 소비자(ops.command-events)를 켜지 않았다(PEAKET_ENV=${peaketEnv}에서만 허락한다)` };
    }
    throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS가 없다(PEAKET_ENV=${peaketEnv || '(없음)'}에서는 명령 사건 소비자가 있어야 한다. local·ci만 없이 뜬다)`);
  }
  const pieces = raw.split(',').map((s) => s.trim());
  const brokers = pieces.filter(Boolean);
  const bad = pieces.findIndex((s) => s !== '' && !BROKER.test(s));
  if (bad >= 0) throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS는 쉼표로 나눈 '호스트:포트' 목록이어야 한다: ${bad + 1}번째 조각이 그 모양이 아니다`);
  if (brokers.length === 0) throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS는 쉼표로 나눈 '호스트:포트' 목록이어야 한다: 빈 조각뿐이다`);
  if (!peaketEnv) throw new PlatformConfigError('PEAKET_ENV가 없어 Kafka 소비자 그룹 이름과 인증을 고를 수 없다');
  return { enabled: true, brokers, auth: kafkaAuthFromEnv('ops-svc', env), env: peaketEnv };
}
