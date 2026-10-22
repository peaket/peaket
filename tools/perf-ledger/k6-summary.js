// k6 handleSummary: 측정이 끝나면 summary.json을 쓴다(표준 출력도 유지).
// 사용: export { handleSummary } from './tools/perf-ledger/k6-summary.js';
export function handleSummary(data) {
  const out = {
    generated_at: new Date().toISOString(),
    metrics: data.metrics,
    root_group: data.root_group,
    options: data.options,
    state: data.state,
  };
  return {
    'summary.json': JSON.stringify(out, null, 2),
    stdout: JSON.stringify({
      http_reqs: data.metrics.http_reqs && data.metrics.http_reqs.values,
      http_req_duration: data.metrics.http_req_duration && data.metrics.http_req_duration.values,
      http_req_failed: data.metrics.http_req_failed && data.metrics.http_req_failed.values,
      dropped_iterations: data.metrics.dropped_iterations && data.metrics.dropped_iterations.values,
    }, null, 2) + '\n',
  };
}
