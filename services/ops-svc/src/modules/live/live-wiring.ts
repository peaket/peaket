// 관제 SSE 모듈의 시작 조립(ADR-0360, F-03-3 ADR-0371 결정 1·7). main.ts·AppModule을 고치지 않으려고 LiveModule.register 안에서 환경 값을 읽는다.
// - PEAKET_PROMETHEUS_URL: 클러스터 안 Prometheus 주소(위젯 값·T-30분 점검 원천). 없으면 위젯 값은 늘 source-unavailable, 점검 항목은 확인할 수 없음이다(local·시험).
//   F-02-1(명령 dry-run)도 같은 이름·같은 뜻으로 읽는다.
// - PEAKET_QUEUE_REDIS_URL 또는 PEAKET_QUEUE_REDIS_CLUSTER_URLS(쉼표): 대기열 Redis(자동 제어 상태 q:{…}:ctl을 읽기만 한다, 읽기 전용 사용자). 없으면 control은 unknown이다.
//   이름과 뜻은 admission-ctrl과 같다.
// - PEAKET_CORE_HTTP_URL: core-svc 내부 판매 설정(회차 단계). 없으면 readiness가 503이다.
// staging·prod(그 밖의 환경 이름 포함)는 셋 가운데 하나라도 없으면 시작하지 않는다(local·ci·demo만 닫힌 대역, 계획 6-3·6-7).
import { loadLogPseudonymizer, type LogPseudonymizer } from '@peaket/platform';
import { NOT_IN_ENV_ENVS } from '../readiness/index.js';
import type { WidgetSource } from './domain/ports.js';
import { PrometheusWidgetSource, UnavailableWidgetSource } from './adapters/prometheus-widget-source.js';

export const PROMETHEUS_URL_ENV = 'PEAKET_PROMETHEUS_URL';
export const QUEUE_REDIS_URL_ENV = 'PEAKET_QUEUE_REDIS_URL';
export const QUEUE_REDIS_CLUSTER_URLS_ENV = 'PEAKET_QUEUE_REDIS_CLUSTER_URLS';
export const CORE_HTTP_URL_ENV = 'PEAKET_CORE_HTTP_URL';
/** 원천이 없어도 뜨는 환경(닫힌 대역) */
export const LIVE_OPEN_ENVS = ['local', 'ci', 'demo'] as const;

export interface LiveWiring {
  /** 환경 이름(PEAKET_ENV, 없으면 플랫폼 설정이 local·ci로 본 시험 조립만 ci, 그 밖은 prod) */
  readonly envName: string;
  readonly prometheusUrl?: string;
  readonly queueRedis?: { readonly url?: string; readonly clusterUrls?: readonly string[] };
  readonly coreUrl?: string;
  readonly internalToken?: string;
  /** 클라우드 전용 점검 항목을 '이 환경에 없음'으로 보이는가(local·ci·demo) */
  readonly cloudLocal: boolean;
}

const trimmed = (v: string | undefined): string | undefined => (v?.trim() ? v.trim() : undefined);

/**
 * 환경 값으로 원천 주소를 고른다. staging·prod에서 원천 주소가 없으면 그 이름을 담아 던진다(시작하지 않는다).
 * @param platformLocal 플랫폼 설정이 local·ci로 본 조립인가(INTERNAL_TOKEN_REQUIRED가 false)
 */
export function liveWiringOf(env: Record<string, string | undefined>, platformLocal: boolean): LiveWiring {
  const envName = trimmed(env.PEAKET_ENV) ?? (platformLocal ? 'ci' : 'prod');
  const prometheusUrl = trimmed(env[PROMETHEUS_URL_ENV]);
  const url = trimmed(env[QUEUE_REDIS_URL_ENV]);
  const clusterUrls = (env[QUEUE_REDIS_CLUSTER_URLS_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const coreUrl = trimmed(env[CORE_HTTP_URL_ENV]);
  const internalToken = trimmed(env.PEAKET_INTERNAL_TOKEN);
  if (!(LIVE_OPEN_ENVS as readonly string[]).includes(envName)) {
    const missing = [
      ...(prometheusUrl ? [] : [PROMETHEUS_URL_ENV]),
      ...(url || clusterUrls.length > 0 ? [] : [`${QUEUE_REDIS_URL_ENV}(또는 ${QUEUE_REDIS_CLUSTER_URLS_ENV})`]),
      ...(coreUrl ? [] : [CORE_HTTP_URL_ENV]),
    ];
    if (missing.length > 0) throw new Error(`${missing.join('·')}가 없다. ${envName}에서는 T-30분 점검·자동 제어 상태 원천 없이 관제 흐름을 열지 않는다(ADR-0371 결정 3·7)`);
  }
  return {
    envName,
    ...(prometheusUrl ? { prometheusUrl } : {}),
    ...(clusterUrls.length > 0 ? { queueRedis: { clusterUrls } } : url ? { queueRedis: { url } } : {}),
    ...(coreUrl ? { coreUrl } : {}),
    ...(internalToken ? { internalToken } : {}),
    cloudLocal: (NOT_IN_ENV_ENVS as readonly string[]).includes(envName),
  };
}

/** 판정자 가명(로그 가명 키, ADR-0053 결정 1). 환경 이름은 위에서 고른 값을 쓴다 */
export function judgePseudonymizerOf(env: Record<string, string | undefined>, w: LiveWiring): LogPseudonymizer {
  return loadLogPseudonymizer({ ...env, PEAKET_ENV: w.envName }).pseudonymizer;
}

/** 환경 값으로 원격 위젯 둘의 원천을 고른다 */
export function widgetSourcesFromEnv(env: Record<string, string | undefined>): WidgetSource[] {
  const url = trimmed(env[PROMETHEUS_URL_ENV]);
  return [url ? PrometheusWidgetSource.fromUrl(url) : new UnavailableWidgetSource()];
}
