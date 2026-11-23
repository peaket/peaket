// realtime-gw 경보 규칙(deploy/platform/observability/alerts/realtime-gw.yaml)의 정적 시험(묶음 BAT-080 G5, RG-02).
// 정본: docs/observability.md §5 SEV2·G-06, docs/features/seat-hold.md §7 '전파 Degraded 자동 전환', ADR-0298.
// - realtime_gw_degraded == 1이면 for 0m으로 바로 SEV2
// - realtime_gw_buffer_slow_connections / realtime_gw_connections >= 0.05가 30초면 SEV2(분모는 realtime_gw_connections)
// - 묶음 대기 p99 150ms 경보는 경고(5분)이고, docs/observability.md §5 512행대로 histogram_quantile 대신
//   le="150" 경계 칸의 비율(150ms 넘는 비율 > 1%)로 계산한다. Degraded 동안에는 realtime_gw_degraded가 갈음한다
// 실행(저장소 뿌리): node --test tools/ci/alert-rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
