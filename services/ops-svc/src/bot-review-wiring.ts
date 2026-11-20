// 표본 검토 시작 조립(BAT-197). 후보 원장은 분석 저장소 ClickHouse(bot_sample_review, OPS-220이 적재)이고,
// local·ci는 PEAKET_BOT_REVIEW_SOURCE=fixture로 시험 시드를 쓴다. 주소가 없으면 닫힌 원장(503)으로 시작한다.
// trust-svc ApplyLabel 주소(PEAKET_TRUST_GRPC_URL)가 없으면 HUMAN·BOT 판정이 503 label-unavailable이다.
import { ClickHouseBotReviewSource, FixtureBotReviewSource, GrpcTrustLabels, UnavailableBotReviewSource } from './modules/bot-review/index.js';
import type { BotReviewSource } from './modules/bot-review/index.js';

export interface BotReviewSourceWiring {
  readonly source: BotReviewSource;
  readonly warning?: string;
}

export function botReviewSourceFromEnv(env: Record<string, string | undefined>): BotReviewSourceWiring {
  const kind = env.PEAKET_BOT_REVIEW_SOURCE ?? 'clickhouse';
  if (kind === 'fixture') return { source: new FixtureBotReviewSource() };
  if (kind !== 'clickhouse') throw new Error(`PEAKET_BOT_REVIEW_SOURCE는 clickhouse·fixture 가운데 하나여야 한다: ${kind}`);
  const url = env.PEAKET_ANALYTICS_CLICKHOUSE_URL;
  if (!url) {
    return {
      source: new UnavailableBotReviewSource(),
      warning: 'PEAKET_ANALYTICS_CLICKHOUSE_URL이 없어 표본 후보 원장을 읽지 못한다(503 bot-review-source-unavailable). local·ci는 PEAKET_BOT_REVIEW_SOURCE=fixture를 쓴다',
    };
  }
  return {
    source: new ClickHouseBotReviewSource({
      baseUrl: url,
      ...(env.PEAKET_ANALYTICS_CLICKHOUSE_USER ? { user: env.PEAKET_ANALYTICS_CLICKHOUSE_USER } : {}),
      ...(env.PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD ? { password: env.PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD } : {}),
    }),
  };
}

/** ApplyLabel 클라이언트. 주소가 없으면 undefined(판정 HUMAN·BOT이 503) */
export function botReviewLabelsFromEnv(env: Record<string, string | undefined>): GrpcTrustLabels | undefined {
  const address = env.PEAKET_TRUST_GRPC_URL;
  if (!address) return undefined;
  return new GrpcTrustLabels({ address, ...(env.PEAKET_INTERNAL_GRPC_TOKEN ? { token: env.PEAKET_INTERNAL_GRPC_TOKEN } : {}) });
}
