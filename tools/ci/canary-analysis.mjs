#!/usr/bin/env node
// F-09-11 카나리 분석 템플릿 생성기(정본: docs/devops.md §6.2, D-T6·D-T7, docs/observability.md §8).
// 값은 이 파일의 CANARY_POLICY 한 곳에만 두고, 생성 파일 `deploy/platform/argo-rollouts/analysis-templates.yaml`을 만든다.
// 쓰는 법: node tools/ci/canary-analysis.mjs --write | --check
// 끝 코드: 0 통과, 1 생성 파일이 없거나 정책과 다르다, 2 인자 오류.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'deploy', 'platform', 'argo-rollouts', 'analysis-templates.yaml');

/** 정본 값. docs/devops.md §6.2(D-T6·D-T7)·G-18 */
export const CANARY_POLICY = Object.freeze({
  interval: '1m',
  count: 2,
  failureLimit: 1,
  // 오류: 안정판의 2배를 넘고, 0.5%p 이상 높고, 5건 이상. 요청 200건 미만은 판정 불가
  error: { multiple: 2, delta: 0.005, minErrors: 5, minRequests: 200 },
  // 지연: 1,000건 이상 p99, 200~999건 p95, 200건 미만 판정 불가. 안정판 × 1.2 + 5ms
  latency: { factor: 1.2, addSeconds: 0.005, p99MinRequests: 1000, p95MinRequests: 200 },
  // 이벤트 루프: 안정판 × 1.5
  eventLoop: { factor: 1.5 },
  prometheus: 'http://prometheus.observability.svc:9090',
  timeout: '30s',
});

const SVC = '{{args.service}}';
const CANARY = '{{args.canary-hash}}';
const STABLE = '{{args.stable-hash}}';
const canary = (metric, extra = '') => `${metric}{service="${SVC}", pod=~"${SVC}-${CANARY}-.*"${extra}}`;
const stable = (metric, extra = '') => `${metric}{service="${SVC}", pod=~"${SVC}-${STABLE}-.*"${extra}}`;
const count = (which) => `sum(increase(${which === 'canary' ? canary('http_server_request_duration_seconds_count', ', status_class!="4xx"') : stable('http_server_request_duration_seconds_count', ', status_class!="4xx"')}[5m]))`;
const errors = (which) => `sum(increase(${which === 'canary' ? canary('http_server_errors_total') : stable('http_server_errors_total')}[5m]))`;
const rate = (which) => `${errors(which)} / clamp_min(${count(which)}, 0.000001)`;

const ERROR_QUERY = `# 200건 미만 가지: (sum(increase(http_server_request_duration_seconds_count{service="svc", pod=~"canary-.*", status_class!="4xx"})) < bool 200) * 2
# 200건 이상 가지: + (sum(increase(http_server_request_duration_seconds_count{service="svc", pod=~"canary-.*", status_class!="4xx"})) >= bool 200) * (...)
(
  (${count('canary')} < bool ${CANARY_POLICY.error.minRequests}) * 2
  +
  (${count('canary')} >= bool ${CANARY_POLICY.error.minRequests}) * (
    (${rate('canary')} > bool ${CANARY_POLICY.error.multiple} * (${rate('stable')}))
    * ((${rate('canary')}) - (${rate('stable')}) >= bool ${CANARY_POLICY.error.delta})
    * (${errors('canary')} >= bool ${CANARY_POLICY.error.minErrors})
  )
)
`;

const LATENCY_QUERY = `# 200건 미만 가지: (sum(increase(http_server_request_duration_seconds_count{service="svc", pod=~"canary-.*", status_class!="5xx"})) < bool 200) * 2
(
  (${count('canary')} < bool ${CANARY_POLICY.latency.p95MinRequests}) * 2
  +
  (${count('canary')} >= bool ${CANARY_POLICY.latency.p95MinRequests}) * (${count('canary')} < bool ${CANARY_POLICY.latency.p99MinRequests}) * (
    histogram_quantile(0.95, sum by (le) (rate(${canary('http_server_request_duration_seconds_bucket', ', status_class!="4xx", status_class!="5xx"')}[5m])))
    > bool (histogram_quantile(0.95, sum by (le) (rate(${stable('http_server_request_duration_seconds_bucket', ', status_class!="4xx", status_class!="5xx"')}[5m]))) * ${CANARY_POLICY.latency.factor} + ${CANARY_POLICY.latency.addSeconds})
  )
  +
  (${count('canary')} >= bool ${CANARY_POLICY.latency.p99MinRequests}) * (
    histogram_quantile(0.99, sum by (le) (rate(${canary('http_server_request_duration_seconds_bucket', ', status_class!="4xx", status_class!="5xx"')}[5m])))
    > bool (histogram_quantile(0.99, sum by (le) (rate(${stable('http_server_request_duration_seconds_bucket', ', status_class!="4xx", status_class!="5xx"')}[5m]))) * ${CANARY_POLICY.latency.factor} + ${CANARY_POLICY.latency.addSeconds})
  )
)
`;

const EVENT_LOOP_QUERY = `(
  max(${canary('nodejs_eventloop_lag_p99_seconds')})
  > bool ${CANARY_POLICY.eventLoop.factor} * max(${stable('nodejs_eventloop_lag_p99_seconds')})
)
`;

function template(name, metricName, query) {
  return `apiVersion: argoproj.io/v1alpha1
kind: ClusterAnalysisTemplate
metadata:
  name: ${name}
  labels:
    app.kubernetes.io/part-of: peaket
spec:
  args:
    - name: service
    - name: canary-hash
    - name: stable-hash
  metrics:
    - name: ${metricName}
      interval: ${CANARY_POLICY.interval}
      count: ${CANARY_POLICY.count}
      failureLimit: ${CANARY_POLICY.failureLimit}
      successCondition: len(result) > 0 && result[0] == 0
      failureCondition: len(result) > 0 && result[0] == 1
      provider:
        prometheus:
          address: ${CANARY_POLICY.prometheus}
          timeout: ${CANARY_POLICY.timeout}
          query: |
${query
  .trimEnd()
  .split('\n')
  .map((line) => `            ${line}`)
  .join('\n')}
`;
}

export function renderAnalysisTemplates() {
  return [
    template('peaket-canary-error-ratio', 'error-ratio', ERROR_QUERY),
    template('peaket-canary-latency', 'latency', LATENCY_QUERY),
    template('peaket-canary-event-loop', 'event-loop', EVENT_LOOP_QUERY),
  ].join('---\n');
}

function main(argv) {
  const mode = argv[0];
  if (mode !== '--write' && mode !== '--check') {
    console.error('쓰는 법: node tools/ci/canary-analysis.mjs --write | --check');
    return 2;
  }
  const expected = renderAnalysisTemplates();
  if (mode === '--write') {
    writeFileSync(OUT, expected, 'utf8');
    console.log(`카나리 분석 템플릿을 썼다: ${OUT}`);
    return 0;
  }
  if (!existsSync(OUT)) {
    console.error(`생성 파일이 없다: ${OUT}`);
    return 1;
  }
  const actual = readFileSync(OUT, 'utf8');
  if (actual !== expected) {
    console.error(`생성 파일이 정책과 다르다: ${OUT}`);
    return 1;
  }
  console.log(`카나리 분석 템플릿이 정책과 같다: ${OUT}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
