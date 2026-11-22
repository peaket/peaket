// 관제 SSE 모듈의 시작 조립(ADR-0360). main.ts·AppModule을 고치지 않으려고 LiveModule.register 안에서 환경 값을 읽는다.
// - PEAKET_PROMETHEUS_URL: 클러스터 안 Prometheus 주소(위젯 값 원천). 없으면 위젯 값은 늘 source-unavailable이다(local·시험).
//   F-02-1(명령 dry-run)도 같은 이름·같은 뜻으로 읽는다.
import type { WidgetSource } from './domain/ports.js';
import { PrometheusWidgetSource, UnavailableWidgetSource } from './adapters/prometheus-widget-source.js';

export const PROMETHEUS_URL_ENV = 'PEAKET_PROMETHEUS_URL';

/** 환경 값으로 위젯 값 원천을 고른다 */
export function widgetSourcesFromEnv(env: Record<string, string | undefined>): WidgetSource[] {
  const url = env[PROMETHEUS_URL_ENV]?.trim();
  return [url ? PrometheusWidgetSource.fromUrl(url) : new UnavailableWidgetSource()];
}
