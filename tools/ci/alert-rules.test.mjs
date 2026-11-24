// realtime-gw 경보 규칙(deploy/platform/observability/alerts/realtime-gw.yaml)의 정적 시험(묶음 BAT-080 G5, RG-02).
// 정본: docs/observability.md §5 SEV2·G-06, docs/features/seat-hold.md §7 '전파 Degraded 자동 전환', ADR-0298.
// - realtime_gw_degraded == 1이면 for 0m으로 바로 SEV2
// - realtime_gw_buffer_slow_connections / realtime_gw_connections >= 0.05가 30초면 SEV2(분모는 realtime_gw_connections)
// - 묶음 대기 p99 150ms 경보는 경고(5분)이고, docs/observability.md §5 512행대로 histogram_quantile 대신
//   le="150" 경계 칸의 비율(150ms 넘는 비율 > 1%)로 계산한다. Degraded 동안에는 realtime_gw_degraded가 갈음한다
// 실행(저장소 뿌리): node --test tools/ci/alert-rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = join(REPO, 'deploy', 'platform', 'observability', 'alerts', 'realtime-gw.yaml');

function rules() {
  assert.ok(existsSync(FILE), '경보 규칙 파일이 없다: deploy/platform/observability/alerts/realtime-gw.yaml');
  const docs = parseAllDocuments(readFileSync(FILE, 'utf8'))
    .map((d) => d.toJS())
    .filter(Boolean);
  assert.equal(docs.length, 1, 'PrometheusRule 하나');
  const pr = docs[0];
  assert.equal(pr.apiVersion, 'monitoring.coreos.com/v1');
  assert.equal(pr.kind, 'PrometheusRule');
  assert.equal(pr.metadata.name, 'realtime-gw');
  assert.equal(pr.metadata.namespace, 'observability');
  const groups = pr.spec.groups ?? [];
  assert.equal(groups.length, 1, '규칙 묶음 하나');
  assert.equal(groups[0].name, 'realtime-gw');
  return groups[0].rules ?? [];
}

test('RG-02 realtime_gw_degraded는 ==1에_for0m으로바로SEV2이고_버퍼포화비율은_분모가realtime_gw_connections이며_5%30초SEV2다', () => {
  const all = rules();
  const by = (name) => {
    const hits = all.filter((r) => r.alert === name);
    assert.equal(hits.length, 1, `경보 ${name}이 하나가 아니다(${hits.length})`);
    return hits[0];
  };
  const degraded = by('realtime_gw_degraded');
  assert.equal(degraded.expr, 'realtime_gw_degraded == 1');
  assert.equal(String(degraded.for), '0m', 'Degraded는 즉시(0m) 울린다');
  assert.equal(degraded.labels.severity, 'sev2');
  assert.equal(degraded.labels.dependency, 'realtime-gw');

  const slow = by('realtime_gw_buffer_slow_connections');
  // 분모가 realtime_gw_connections여야 한다. _total·connections_total 같은 다른 지표면 비율이 틀어진다
  assert.equal(slow.expr, 'realtime_gw_buffer_slow_connections / realtime_gw_connections >= 0.05');
  assert.equal(String(slow.for), '30s');
  assert.equal(slow.labels.severity, 'sev2');
  assert.equal(slow.labels.dependency, 'realtime-gw');
  // 경계: 5% 미만이거나 30초보다 짧으면 울리지 않는다(값은 식과 for에서 온다)
  assert.match(slow.expr, />=\s*0\.05$/);
  assert.notEqual(String(slow.for), '5m');

  // 경보 이름이 겹치지 않고, 모든 경보는 런북과 게임데이를 가리킨다
  assert.equal(new Set(all.map((r) => r.alert)).size, all.length);
  // 심각도: Degraded·버퍼는 SEV2, 묶음 대기 p99는 경고로 SEV3 sev3(티켓, docs/features/seat-hold.md §7 443행, docs/observability.md §5 심각도 표)
  assert.deepEqual(
    all.map((r) => [r.alert, r.labels?.severity]).sort(),
    [
      ['realtime_gw_batch_wait_p99_high', 'sev3'],
      ['realtime_gw_buffer_slow_connections', 'sev2'],
      ['realtime_gw_degraded', 'sev2'],
    ],
    '경보 셋의 심각도',
  );
  for (const r of all) {
    assert.match(r.annotations?.summary ?? '', /\S/, `${r.alert}: summary`);
    assert.match(r.annotations?.runbook_url ?? '', /^https:\/\/github\.com\/peaket\/peaket\/blob\/develop\/docs\//, `${r.alert}: runbook_url`);
  }
});

test('RG-02 묶음대기p99경보는_histogram_quantile대신_le150경계칸비율1%가_5분이면울리는_경고다', () => {
  const all = rules();
  const p99 = all.filter((r) => r.alert === 'realtime_gw_batch_wait_p99_high');
  assert.equal(p99.length, 1, '묶음 대기 p99 경보가 하나가 아니다');
  const r = p99[0];
  assert.equal(String(r.for), '5m');
  // 150ms [가정]를 5분 넘는다는 경고이고 경보 라벨은 SEV3 sev3(티켓)다(docs/features/seat-hold.md §7 443행). SEV2가 아니다
  assert.equal(r.labels.severity, 'sev3', '묶음 대기 p99 경보는 SEV3 sev3다(SEV2 아님)');
  // 정본 docs/observability.md §5 512행: 지연 경보는 histogram_quantile 대신 경계 칸(le=150)의 비율로 쓴다
  assert.doesNotMatch(r.expr, /histogram_quantile/, 'histogram_quantile을 썼다(경계 칸 비율로 계산해야 한다)');
  assert.match(r.expr, /realtime_gw_batch_wait_ms_bucket\{[^}]*le\s*=\s*["']150["']/, 'le="150" 경계 칸이 없다');
  assert.match(r.expr, /realtime_gw_batch_wait_ms_count/, '분모가 realtime_gw_batch_wait_ms_count가 아니다');
  assert.match(r.expr, /\/\s*sum\(/, '경계 칸 비율(나눗셈)이 아니다');
  // 150ms 넘는 비율 > 1% (또는 150ms 이하 비율 < 99%)
  assert.ok(/>\s*0?\.01\b/.test(r.expr) || /<\s*0?\.99\b/.test(r.expr), `1% 기준이 없다: ${r.expr}`);
  assert.match(r.expr, /\[5m\]/, '5분 창이 아니다');
  // Degraded가 아닐 때만 참이어야 한다(아니면 Degraded 동안 두 경보가 함께 울린다)
  assert.match(r.expr, /and on\(\)\s*\(sum\(realtime_gw_degraded\) == 0\)/);
  const desc = r.annotations?.description ?? '';
  for (const want of ['150ms', '1%', '5분']) assert.ok(desc.includes(want), `설명에 ${want}가 없다: ${desc}`);
  assert.match(desc, /갈음/);
});

test('RG-02 경보 규칙 주석에_RB-23·G-06과_SEV2근거가있고_비밀값이없다 [ASVS v5.0.0-13.1.4]', () => {
  const text = readFileSync(FILE, 'utf8');
  for (const want of ['RB-23', 'RB-06', 'G-06', 'SEV2', 'docs/observability.md §5']) assert.ok(text.includes(want), want);
  // 경보 파일에 자격 증명·토큰 값을 두지 않는다
  assert.doesNotMatch(text, /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9+/_=-]{8,}/i);
});

// ---------------------------------------------------------------------------
// V-T52 ⑪ 나머지 경보 규칙(OPS-100, F-01-10)의 정적 시험.
// 정본: docs/observability.md §5 'OPS-100 규칙과 이름이 없던 지표'·심각도 표, docs/verification.md V-T52.
// 합성 시계열 시험(V-T52 ①~⑩)은 deploy/platform/observability/test/ops-100.test.yaml이 맡고,
// 이 절은 규칙 파일이 정본의 이름·라벨·for·주석·임계를 그대로 갖는지와 다른 규칙 파일과 이름이 겹치지 않는지를 본다.
// ---------------------------------------------------------------------------
const OPS_FILE = join(REPO, 'deploy', 'platform', 'observability', 'alerts', 'ops-100.yaml');
const RULE_DIRS = ['rules', 'alerts', 'mimir/rules'];
const OPS_GROUPS = [
  'ops-100-dependencies',
  'ops-100-hygiene',
  'ops-100-field',
  'ops-100-queue-budget',
  'ops-100-legal',
  'ops-100-broker',
  'ops-100-payment-consumers',
  'ops-100-transferred',
];
/** [이름, severity, kind, for, 식에 있어야 하는 조각] (for는 YAML 문자열 그대로) */
const OPS_ALERTS = [
  ['external_dependency_error_ratio_high', 'sev2', 'cause', '5m', ['dependency_requests_total', 'outcome=~"error|timeout"', '> 0.01']],
  ['payment_pg_throttled_first', 'sev2', 'cause', '0m', ['pg_throttled_total{first="true"}', '> 0']],
  ['cdn_quota_utilization_high', 'sev3', 'cause', '10m', ['cdn_quota_utilization_ratio', '> 0.8']],
  ['node_clock_offset_high', 'sev2', 'hygiene', '5m', ['abs(node_timex_offset_seconds)', '> 0.02']],
  ['cross_region_backup_stale', 'sev2', 'hygiene', '5m', ['backup_cross_region_last_success_timestamp_seconds', '> 26 * 3600']],
  ['clickhouse_backup_stale', 'sev3', 'hygiene', '5m', ['backup_last_success_timestamp_seconds{store="clickhouse"}', '> 26 * 3600']],
  ['certificate_renewal_overdue', 'sev3', 'hygiene', '5m', ['certificate_renewal_overdue == 1', '(certificate_expiry_timestamp_seconds - time())', '>= ']],
  ['certificate_expiry_urgent', 'sev2', 'hygiene', '5m', ['certificate_renewal_overdue == 1', '(certificate_expiry_timestamp_seconds - time())', '< ']],
  ['scanner_sync_stale', 'sev2', 'field', '1m', ['scanner_last_sync_timestamp_seconds', '> 120']],
  ['scanner_duplicate_entry_high', 'sev3', 'field', '0m', ['scanner_duplicate_entry_total', 'increase(', '> 10']],
  ['queue_admit_before_turn', 'sev1', 'invariant', '0m', ['queue_admit_before_turn_total', '> 0']],
  ['admission_budget_reduction_executed', 'sev2', 'control', '0m', ['admission_target_decrease_total{reason="budget_50"}', '> 0']],
  ['security_incident_duty_due_soon', 'sev2', 'legal', '1m', ['security_incident_duty_due_seconds{duty=~"breach_report|additional_facts_report"}', '< 7200', 'personal_data_subject_notice|leak_report|leak_possible_notice', '< 43200']],
  ['security_incident_duty_breached', 'sev2', 'legal', '0m', ['security_incident_duty_breached_total', '> 0']],
  ['msk_offline_partitions_trade_control', 'sev1', 'cause', '1m', ['aws_kafka_offline_partitions_count_average{cluster=~"trade|control"}', '> 0']],
  ['msk_offline_partitions_telemetry', 'sev2', 'cause', '1m', ['aws_kafka_offline_partitions_count_average{cluster="telemetry"}', '> 0']],
  ['msk_under_min_isr_trade_control', 'sev2', 'cause', '1m', ['aws_kafka_under_min_isr_partition_count_average{cluster=~"trade|control"}', '> 0']],
  ['msk_under_min_isr_telemetry', 'sev3', 'cause', '1m', ['aws_kafka_under_min_isr_partition_count_average{cluster="telemetry"}', '> 0']],
  ['msk_under_replicated_partitions', 'sev3', 'cause', '10m', ['aws_kafka_under_replicated_partitions_average', '> 0']],
  ['msk_disk_used_warning', 'sev3', 'cause', '10m', ['aws_kafka_kafka_data_logs_disk_used_average', '> 70']],
  ['msk_disk_used_high', 'sev2', 'cause', '5m', ['aws_kafka_kafka_data_logs_disk_used_average', '> 85']],
  ['payment_result_pull_used', 'sev3', 'cause', '0m', ['payment_result_pulled_total', '> 0']],
  ['payment_result_pull_failed', 'sev2', 'cause', '1m', ['payment_result_pull_failures_total', '> 0']],
  ['consumer_held_events_trade', 'sev2', 'cause', '1m', ['consumer_held_events{topic=~"trade\\\\.payments|trade\\\\.orders"}', '> 0']],
  ['consumer_held_events_other', 'sev3', 'cause', '1m', ['consumer_held_events{topic!~"trade\\\\.payments|trade\\\\.orders"}', '> 0']],
  ['evidence_collection_failed', 'sev3', 'hygiene', '0m', ['evidence_collections_total{result="failed"}', '> 1']],
  ['evidence_webhook_rejected_high', 'sev3', 'security', '0m', ['evidence_webhook_rejected_total', '>= 5']],
  ['rt_degraded', 'sev3', 'hygiene', '0m', ['rt_degraded == 1']],
  ['rt_trade_gap_events', 'sev3', 'hygiene', '0m', ['rt_trade_gap_events > 0']],
  ['otelcol_exporter_send_failed', 'sev3', 'hygiene', '5m', ['otelcol_exporter_send_failed_', '> 0']],
  ['otelcol_exporter_queue_high', 'sev3', 'hygiene', '5m', ['otelcol_exporter_queue_size', 'otelcol_exporter_queue_capacity', '> 0.8']],
  ['otelcol_receiver_refused', 'sev3', 'hygiene', '5m', ['otelcol_receiver_refused_', '> 0']],
  ['otelcol_intake_zero', 'sev3', 'hygiene', '5m', ['tempo_distributor_bytes_received_total', 'loki_distributor_bytes_received_total', '== 0']],
  ['otelcol_tail_sampling_dropped_early', 'sev3', 'hygiene', '5m', ['otelcol_processor_tail_sampling_sampling_trace_dropped_too_early', '> 0']],
];

function opsGroups() {
  assert.ok(existsSync(OPS_FILE), '경보 규칙 파일이 없다: deploy/platform/observability/alerts/ops-100.yaml');
  const docs = parseAllDocuments(readFileSync(OPS_FILE, 'utf8'))
    .map((d) => d.toJS())
    .filter(Boolean);
  assert.equal(docs.length, 1, 'PrometheusRule 하나');
  const pr = docs[0];
  assert.equal(pr.apiVersion, 'monitoring.coreos.com/v1');
  assert.equal(pr.kind, 'PrometheusRule');
  assert.equal(pr.metadata.name, 'ops-100');
  assert.equal(pr.metadata.namespace, 'observability');
  return pr.spec.groups ?? [];
}

test('V-T52 ⑪ OPS-100 규칙은 묶음 여덟·평가 30초·경보 34개이고 이름이 다른 규칙 파일과 겹치지 않는다', () => {
  const groups = opsGroups();
  assert.deepEqual(groups.map((g) => g.name), OPS_GROUPS, '묶음 이름·차례');
  for (const g of groups) assert.equal(String(g.interval), '30s', `${g.name}: 평가 간격`);
  const all = groups.flatMap((g) => g.rules ?? []);
  const alerts = all.filter((r) => r.alert);
  assert.deepEqual(
    alerts.map((r) => r.alert).sort(),
    OPS_ALERTS.map(([n]) => n).sort(),
    '경보 이름 집합',
  );
  // 다른 규칙 파일(rules/·alerts/·mimir/rules/)과 이름이 겹치지 않는다
  const elsewhere = new Set();
  for (const dir of RULE_DIRS) {
    const abs = join(REPO, 'deploy', 'platform', 'observability', dir);
    if (dir === 'alerts' || !existsSync(abs)) continue;
    for (const f of readdirSync(abs).filter((x) => /\.ya?ml$/.test(x))) {
      for (const d of parseAllDocuments(readFileSync(join(abs, f), 'utf8')).map((x) => x.toJS()).filter(Boolean)) {
        for (const g of d?.spec?.groups ?? d?.groups ?? []) for (const r of g.rules ?? []) if (r.alert) elsewhere.add(r.alert);
      }
    }
  }
  for (const [name] of OPS_ALERTS) assert.ok(!elsewhere.has(name), `${name}이 다른 규칙 파일에도 있다`);
});

test('V-T52 ⑪ OPS-100 경보마다 정본의 severity·kind·for·임계와 주석이 있다', () => {
  const alerts = opsGroups().flatMap((g) => g.rules ?? []).filter((r) => r.alert);
  const by = (name) => {
    const hits = alerts.filter((r) => r.alert === name);
    assert.equal(hits.length, 1, `${name}이 하나가 아니다(${hits.length})`);
    return hits[0];
  };
  for (const [name, severity, kind, forValue, pieces] of OPS_ALERTS) {
    const r = by(name);
    assert.equal(r.labels?.severity, severity, `${name}: severity`);
    assert.equal(r.labels?.kind, kind, `${name}: kind`);
    assert.equal(String(r.for), forValue, `${name}: for`);
    for (const piece of pieces) assert.ok(String(r.expr).includes(piece), `${name}: 식에 '${piece}'가 없다: ${r.expr}`);
    for (const key of ['summary', 'runbook_url', 'dashboard_url']) {
      assert.ok(typeof r.annotations?.[key] === 'string' && r.annotations[key].trim() !== '', `${name}: 주석 ${key}`);
    }
    assert.match(r.annotations.runbook_url, /^https:\/\/github\.com\/peaket\/peaket\/blob\/develop\/docs\//, `${name}: runbook_url`);
    assert.match(r.annotations.dashboard_url, /^\/d\/peaket-/, `${name}: dashboard_url`);
  }
  // 목록 밖 라벨·사람 식별값이 없다(허용: severity·kind·dependency·pg·event_id)
  for (const r of alerts) {
    for (const k of Object.keys(r.labels ?? {})) {
      assert.ok(['severity', 'kind', 'dependency', 'pg', 'event_id'].includes(k), `${r.alert}: 라벨 ${k}`);
    }
  }
  assert.doesNotMatch(readFileSync(OPS_FILE, 'utf8'), /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9+/_=-]{8,}/i);
});
